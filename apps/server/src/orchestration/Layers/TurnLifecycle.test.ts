import { GitCore } from "../../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../../git/testDoubles.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import { ProviderTurnDeliveryWorkerLive } from "./ProviderTurnDeliveryWorker.ts";
import { ProviderTurnDeliveryRepositoryLive } from "./ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { NextTurnQueueDispatcherLive } from "../../nextTurnQueue/Layers/NextTurnQueueDispatcher.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { recoverRestartTurnMarkers } from "../../nextTurnQueue/restartTurns.ts";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { NextTurnQueueStoreLive } from "../../nextTurnQueue/Layers/NextTurnQueueStore.ts";
import { NextTurnQueueStore } from "../../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const suite = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ServerSettingsService.layerTest({ resumeActiveTurnsAfterRestart: true })),
    Layer.provideMerge(NextTurnQueueStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "phase8-tests-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);
const at = "2026-09-30T12:00:00.000Z";
const seed = (name: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.makeUnsafe(name);
    const projectId = ProjectId.makeUnsafe(`project:${name}`);
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(`project:${name}`),
      projectId,
      title: "Phase 8",
      workspaceRoot: "/tmp/no-git",
      defaultModel: "gpt-5-codex",
      createdAt: at,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`thread:${name}`),
      threadId,
      projectId,
      title: name,
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
    });
    return threadId;
  });
const interrupted = (threadId: ThreadId, turnId = "old-turn") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    for (const busy of [true, false])
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`interrupt:${threadId}:${turnId}:${busy}`),
        threadId,
        createdAt: at,
        session: {
          threadId,
          providerName: "codex",
          status: busy ? "running" : "stopped",
          runtimeMode: "full-access",
          activeTurnId: busy ? TurnId.makeUnsafe(turnId) : null,
          lastError: null,
          updatedAt: at,
        },
      });
  });
const question = (threadId: ThreadId, message = true, turnId = "old-turn") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const requestId = ApprovalRequestId.makeUnsafe(`question:${threadId}:${turnId}`);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`ask:${threadId}:${turnId}`),
      threadId,
      createdAt: at,
      activity: {
        id: EventId.makeUnsafe(`ask:${threadId}:${turnId}`),
        kind: "user-input.requested",
        tone: "info",
        summary: "Question",
        turnId: TurnId.makeUnsafe(turnId),
        createdAt: at,
        payload: {
          requestId,
          ...(message ? { responseMode: "message" } : {}),
          questions: [
            {
              id: "0",
              header: "Question",
              question: "Choose",
              options: [{ label: "A", description: "A" }],
              multiSelect: true,
            },
          ],
        },
      },
    });
    return requestId;
  });
suite("durable turn lifecycle", (it) => {
  it.effect(
    "dispatches steering alongside an unresolved ACP start while keeping starts ordered",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed("acp-steering");
        const otherThreadId = yield* seed("acp-next-start");
        const engine = yield* OrchestrationEngineService;
        const store = yield* NextTurnQueueStore;
        const startEntered = yield* Deferred.make<void>();
        const finishPrompt = yield* Deferred.make<void>();
        const steerEntered = yield* Deferred.make<void>();
        const activeTurnId = TurnId.makeUnsafe("acp-active-turn");
        const delivered: string[] = [];
        let startFinished = false;
        const reactor = Layer.succeed(ProviderCommandReactor, {
          deliverTurnStart: (event: OrchestrationEvent) =>
            Effect.gen(function* () {
              delivered.push(event.type);
              if (event.type === "thread.turn-steer-requested") {
                assert.equal(startFinished, false);
                yield* Deferred.succeed(steerEntered, undefined);
                return { turnId: activeTurnId };
              }
              if (event.aggregateId === threadId) {
                yield* engine.dispatch({
                  type: "thread.session.set",
                  commandId: CommandId.makeUnsafe("acp:running"),
                  threadId,
                  createdAt: at,
                  session: {
                    threadId,
                    providerName: "codex",
                    status: "running",
                    runtimeMode: "full-access",
                    activeTurnId,
                    lastError: null,
                    updatedAt: at,
                  },
                });
                yield* Deferred.succeed(startEntered, undefined);
                yield* Deferred.await(finishPrompt);
                startFinished = true;
              }
              return { turnId: activeTurnId };
            }),
          recordTurnStartFailure: () => Effect.void,
        } as never);
        const command = (name: string, target = threadId) => ({
          type: "thread.turn.start" as const,
          commandId: CommandId.makeUnsafe(`acp:${name}`),
          threadId: target,
          message: {
            messageId: MessageId.makeUnsafe(`acp-message:${name}`),
            role: "user" as const,
            text: name,
            attachments: [],
          },
          provider: "codex" as const,
          model: "gpt-5-codex",
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdAt: at,
        });
        const insert = (name: string, steer = false) =>
          store.insertSubmission({
            submissionId: CommandId.makeUnsafe(`acp-submission:${name}`),
            itemId: CommandId.makeUnsafe(`acp-item:${name}`),
            requestHash: name,
            atHead: steer,
            command: { ...command(name), ...(steer ? { expectedTurnId: activeTurnId } : {}) },
          });
        yield* Effect.gen(function* () {
          const worker = yield* ProviderTurnDeliveryWorker;
          const dispatcher = yield* NextTurnQueueDispatcher;
          yield* worker.start;
          yield* Effect.yieldNow;
          yield* insert("original");
          yield* dispatcher.notify(threadId);
          yield* dispatcher.drain;
          yield* Deferred.await(startEntered);
          // Another start is durable, but must not overtake the unresolved prompt.
          yield* engine.dispatch(command("next", otherThreadId));
          yield* insert("steer", true);
          yield* dispatcher.notify(threadId);
          yield* dispatcher.drain;
          yield* Deferred.await(steerEntered);
          assert.deepEqual(delivered, [
            "thread.turn-start-requested",
            "thread.turn-steer-requested",
          ]);
          const draining = yield* worker.drain.pipe(Effect.forkChild);
          assert.equal(draining.pollUnsafe(), undefined);
          yield* Deferred.succeed(finishPrompt, undefined);
          yield* Fiber.join(draining);
          assert.deepEqual(delivered, [
            "thread.turn-start-requested",
            "thread.turn-steer-requested",
            "thread.turn-start-requested",
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(ProviderTurnDeliveryWorkerLive, NextTurnQueueDispatcherLive).pipe(
              Layer.provide(reactor),
              Layer.provide(
                Layer.succeed(ProviderService, {
                  readThread: () => Effect.succeed({ threadId, turns: [] }),
                } as never),
              ),
              Layer.provide(Layer.succeed(GitCore, makeFakeGitCore().service)),
              Layer.provide(
                Layer.succeed(RuntimeReceiptBus, {
                  publish: () => Effect.void,
                  stream: Stream.empty,
                }),
              ),
              Layer.provideMerge(ProviderTurnDeliveryRepositoryLive),
            ),
          ),
        );
      }),
  );
  it.effect(
    "rewind removes discarded questions from memory, snapshots and replay, and rejects stale answers",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed("rewind-question");
        const kept = yield* question(threadId, true, "kept-turn");
        const discarded = yield* question(threadId, true, "discarded-turn");
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.revert.complete",
          commandId: CommandId.makeUnsafe("revert:questions"),
          threadId,
          turnCount: 1,
          retainedTurnIds: [TurnId.makeUnsafe("kept-turn")],
          createdAt: at,
        });
        assert.deepEqual(
          (yield* engine.getReadModel()).threads
            .find((t) => t.id === threadId)!
            .pendingUserInputs!.map((input) => input.requestId),
          [kept],
        );
        const query = yield* ProjectionSnapshotQuery;
        assert.deepEqual(
          (yield* query.getSnapshot()).threads
            .find((t) => t.id === threadId)!
            .pendingUserInputs!.map((input) => input.requestId),
          [kept],
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.pendingUserInputs}`;
        yield* (yield* OrchestrationProjectionPipeline).bootstrap;
        assert.deepEqual(
          (yield* query.getSnapshot()).threads
            .find((t) => t.id === threadId)!
            .pendingUserInputs!.map((input) => input.requestId),
          [kept],
        );
        const stale = yield* Effect.exit(
          engine.dispatch({
            type: "thread.user-input.respond",
            commandId: CommandId.makeUnsafe("answer:discarded-question"),
            threadId,
            requestId: discarded,
            answers: { "0": { answers: ["A"] } },
            createdAt: at,
          }),
        );
        assert.equal(stale._tag, "Failure");
        assert.equal((yield* (yield* NextTurnQueueStore).listByThread(threadId)).items.length, 0);
      }),
  );
  it.effect(
    "enqueues each restart continuation once and retains ineligible markers until expiry",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed("restart-continuation");
        const blockedThread = yield* seed("restart-question");
        const requestId = yield* question(blockedThread);
        const expiredThread = yield* seed("restart-expired");
        const sql = yield* SqlClient.SqlClient;
        yield* interrupted(threadId);
        yield* interrupted(blockedThread);
        const marked = new Date().toISOString();
        const continuationId = `resume:${threadId}:old-turn`;
        yield* sql`INSERT INTO restart_turn_markers VALUES (${threadId}, 'old-turn', ${marked}, ${continuationId})`;
        yield* sql`INSERT INTO restart_turn_markers VALUES (${blockedThread}, 'old-turn', ${marked}, ${`resume:${blockedThread}:old-turn`})`;
        yield* sql`INSERT INTO restart_turn_markers VALUES (${expiredThread}, 'old-turn', ${new Date(Date.now() - 31 * 60_000).toISOString()}, ${`resume:${expiredThread}:old-turn`})`;
        assert.deepEqual(yield* recoverRestartTurnMarkers, [threadId]);
        assert.deepEqual(yield* recoverRestartTurnMarkers, []);
        const store = yield* NextTurnQueueStore;
        const queue = yield* store.listByThread(threadId);
        assert.equal(queue.items.length, 1);
        assert.equal(queue.items[0]!.submissionId, CommandId.makeUnsafe(continuationId));
        assert.equal(queue.items[0]!.command.presentation, "continuation");
        assert.equal(
          (yield* sql`SELECT * FROM restart_turn_markers WHERE thread_id = ${blockedThread}`)
            .length,
          1,
        );
        assert.equal(
          (yield* sql`SELECT * FROM restart_turn_markers WHERE thread_id = ${expiredThread}`)
            .length,
          0,
        );
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.makeUnsafe("restart:dismiss"),
          threadId: blockedThread,
          requestId,
          createdAt: at,
        });
        assert.deepEqual(yield* recoverRestartTurnMarkers, [blockedThread]);
      }),
  );

  it.effect("revokes restart markers after opt-out or newer conversation work", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("restart-revoked");
      yield* interrupted(threadId);
      const sql = yield* SqlClient.SqlClient;
      const marker = () =>
        sql`INSERT INTO restart_turn_markers VALUES (${threadId}, 'old-turn', ${new Date().toISOString()}, ${`resume:${threadId}:old-turn`})`;
      yield* marker();
      yield* interrupted(threadId, "newer-turn");
      assert.deepEqual(yield* recoverRestartTurnMarkers, []);
      assert.equal(
        (yield* sql`SELECT * FROM restart_turn_markers WHERE thread_id = ${threadId}`).length,
        0,
      );
      const optedOutThread = yield* seed("restart-opted-out");
      yield* interrupted(optedOutThread);
      yield* sql`INSERT INTO restart_turn_markers VALUES (${optedOutThread}, 'old-turn', ${new Date().toISOString()}, ${`resume:${optedOutThread}:old-turn`})`;
      yield* (yield* ServerSettingsService).updateSettings({
        resumeActiveTurnsAfterRestart: false,
      });
      assert.deepEqual(yield* recoverRestartTurnMarkers, []);
      assert.equal(
        (yield* sql`SELECT * FROM restart_turn_markers WHERE thread_id = ${threadId}`).length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT * FROM restart_turn_markers WHERE thread_id = ${optedOutThread}`).length,
        0,
      );
      yield* (yield* ServerSettingsService).updateSettings({ resumeActiveTurnsAfterRestart: true });
    }),
  );

  it.effect(
    "resolves a message question and commits exactly one independently deliverable answer",
    () =>
      Effect.gen(function* () {
        const threadId = yield* seed("async-atomic");
        const requestId = yield* question(threadId);
        const engine = yield* OrchestrationEngineService;
        const store = yield* NextTurnQueueStore;
        const commandId = CommandId.makeUnsafe("resolve:atomic");
        const command = {
          type: "thread.user-input.respond" as const,
          commandId,
          threadId,
          requestId,
          answers: { "0": { answers: ["A", "typed"] } },
          createdAt: at,
        };
        const receipt = yield* engine.dispatch(command);
        assert.deepEqual(yield* engine.dispatch(command), receipt);
        const queue = yield* store.listByThread(threadId);
        assert.equal(queue.items.length, 1);
        assert.notEqual(queue.items[0]!.command.commandId, commandId);
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${queue.items[0]!.command.commandId}`)
            .length,
          0,
        );
        assert.equal(
          (yield* engine.getReadModel()).threads.find((thread) => thread.id === threadId)!
            .pendingUserInputs?.length,
          0,
        );
        const duplicate = yield* Effect.exit(
          engine.dispatch({ ...command, commandId: CommandId.makeUnsafe("resolve:duplicate") }),
        );
        assert.equal(duplicate._tag, "Failure");
        const snapshot = yield* ProjectionSnapshotQuery;
        assert.equal(
          (yield* snapshot.getSnapshot()).threads.find((thread) => thread.id === threadId)!
            .pendingUserInputs?.length,
          0,
        );
      }),
  );
  it.effect("replays unresolved questions with their own cursor after activity retention", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("question-replay");
      yield* question(threadId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_pending_user_inputs WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.pendingUserInputs}`;
      const pipeline = yield* OrchestrationProjectionPipeline;
      yield* pipeline.bootstrap;
      const query = yield* ProjectionSnapshotQuery;
      assert.equal(
        (yield* query.getSnapshot()).threads.find((thread) => thread.id === threadId)!
          .pendingUserInputs?.length,
        1,
      );
    }),
  );

  it.effect(
    "answer attachment owners follow message and blocking delivery paths and survive rollback",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* OrchestrationEngineService;
        for (const messageMode of [true, false]) {
          const threadId = yield* seed(
            messageMode ? "answer-attachment-async" : "answer-attachment-blocking",
          );
          const requestId = yield* question(threadId, messageMode);
          const commandId = CommandId.makeUnsafe(`attachment-answer:${threadId}`);
          const attachment = {
            type: "file" as const,
            id: `attachment-${threadId}`,
            name: "answer.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
          };
          yield* sql`INSERT INTO attachments(attachment_id,thread_id,type,name,mime_type,size_bytes,content_hash,final_path,lifecycle,created_at,updated_at) VALUES (${attachment.id},${threadId},'file','answer.txt','text/plain',1,'hash','/tmp/answer.txt','ready',${at},${at})`;
          yield* sql`INSERT INTO attachment_owners VALUES (${attachment.id},'ingress',${commandId},${at})`;
          yield* engine.dispatch({
            type: "thread.user-input.respond",
            commandId,
            threadId,
            requestId,
            answers: { "0": { answers: ["A"] } },
            attachments: [attachment],
            createdAt: at,
          });
          const owners = yield* sql<{
            kind: string;
          }>`SELECT owner_kind AS kind FROM attachment_owners WHERE attachment_id = ${attachment.id}`;
          assert.deepEqual(
            owners.map((owner) => owner.kind),
            [messageMode ? "queue_item" : "user_input"],
          );
          yield* engine.dispatch({
            type: "thread.revert.complete",
            commandId: CommandId.makeUnsafe(`attachment-revert:${threadId}`),
            threadId,
            turnCount: 0,
            createdAt: at,
          });
          assert.equal(
            (yield* sql`SELECT * FROM attachment_owners WHERE attachment_id = ${attachment.id}`)
              .length,
            1,
          );
        }
      }),
  );
  it.effect("a message question remains open after its turn ends", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("async-outlives-turn");
      yield* question(threadId);
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("async:turn-settled"),
        threadId,
        session: {
          threadId,
          providerName: "codex",
          status: "ready",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      });
      assert.equal(
        (yield* engine.getReadModel()).threads.find((thread) => thread.id === threadId)!
          .pendingUserInputs?.length,
        1,
      );
    }),
  );

  it.effect("dismissing a message question creates no delivery", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("async-dismiss");
      const requestId = yield* question(threadId);
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.makeUnsafe("dismiss:async"),
        threadId,
        requestId,
        createdAt: at,
      });
      const store = yield* NextTurnQueueStore;
      assert.equal((yield* store.listByThread(threadId)).items.length, 0);
    }),
  );
  it.effect("skips corrupt pending questions and rewind drafts while projecting valid rows", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("corrupt-runtime-rows");
      const requestId = yield* question(threadId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_pending_user_inputs VALUES (${threadId}, 'bad-question', '{', NULL)`;
      yield* sql`INSERT INTO rewind_operations(operation_id, thread_id, target_message_id, provider_session_id, mode, expected_revision, state, relative_count, retained_count, boundary_json, draft_json, created_at, updated_at) VALUES ('bad-draft', ${threadId}, 'bad-message', 'session', 'conversation', 0, 'completed', 1, 0, '[]', '{', ${at}, ${at})`;
      const query = yield* ProjectionSnapshotQuery;
      assert.equal(
        (yield* query.getSnapshot()).threads.find((thread) => thread.id === threadId)
          ?.pendingUserInputs?.[0]?.requestId,
        requestId,
      );
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.makeUnsafe("dismiss-corrupt-neighbor"),
        threadId,
        requestId,
        createdAt: at,
      });
      const snapshot = yield* query.getSnapshot();
      assert.equal(
        snapshot.threads.find((thread) => thread.id === threadId)?.pendingUserInputs?.length,
        0,
      );
      assert.equal(
        snapshot.threads.find((thread) => thread.id === threadId)?.rewindDrafts?.length,
        0,
      );
    }),
  );

  {
    let commandCounter = 0;
    const setup = (name: string) =>
      Effect.gen(function* () {
        const threadId = yield* seed(name);
        const sql = yield* SqlClient.SqlClient;
        const engine = yield* OrchestrationEngineService;
        const operationId = `rewind:${name}`;
        const setState = (state: string) =>
          sql`INSERT INTO rewind_operations(operation_id, thread_id, target_message_id, provider_session_id, mode, expected_revision, state, relative_count, retained_count, boundary_json, draft_json, error, created_at, updated_at) VALUES (${operationId}, ${threadId}, 'prompt-1', 'session', 'conversation', 0, ${state}, 1, 0, '[]', '{"text":"Prompt","attachments":[]}', 'rejected', ${at}, ${at}) ON CONFLICT(operation_id) DO UPDATE SET state = ${state}`;
        const pauseQueue = (reason: string) =>
          sql`INSERT INTO next_turn_queue_state(thread_id, paused, pause_reason_code, revision, updated_at) VALUES (${threadId}, 1, ${reason}, 1, ${at}) ON CONFLICT(thread_id) DO UPDATE SET paused = 1, pause_reason_code = ${reason}`;
        const queue = sql<{
          paused: number;
          reason: string | null;
        }>`SELECT paused, pause_reason_code AS reason FROM next_turn_queue_state WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows) => rows[0]!),
        );
        // Each click gets a fresh command id, as the panel does.
        const dispatch = (intent?: "cancel") =>
          engine.dispatch({
            type: "thread.rewind-draft.resolve",
            commandId: CommandId.makeUnsafe(`${operationId}:click:${commandCounter++}`),
            operationId: CommandId.makeUnsafe(operationId),
            threadId,
            ...(intent ? { intent } : {}),
            createdAt: at,
          });
        yield* sql`INSERT INTO rewind_requests(operation_id, thread_id, payload_json, created_at, queue_state_json) VALUES (${operationId}, ${threadId}, '{}', ${at}, ${JSON.stringify({ paused: 0, pause_reason_code: null, pause_detail: null })})`;
        const exists = (table: "rewind_operations" | "rewind_requests") =>
          (table === "rewind_operations"
            ? sql`SELECT 1 FROM rewind_operations WHERE operation_id = ${operationId}`
            : sql`SELECT 1 FROM rewind_requests WHERE operation_id = ${operationId}`
          ).pipe(Effect.map((rows) => rows.length > 0));
        return { sql, operationId, setState, pauseQueue, queue, dispatch, exists };
      });

    it.effect("rewind cancel: unblocks a prepared rewind and restores the queue", () =>
      Effect.gen(function* () {
        const t = yield* setup("cancel-prepared");
        yield* t.setState("prepared");
        yield* t.pauseQueue("reconciliation_required");
        yield* t.dispatch("cancel");
        assert.equal(yield* t.exists("rewind_operations"), false);
        assert.equal(yield* t.exists("rewind_requests"), false);
        assert.deepEqual(yield* t.queue, { paused: 0, reason: null });
      }),
    );

    it.effect("rewind cancel: a rejected cancel does not block a later one", () =>
      Effect.gen(function* () {
        const t = yield* setup("cancel-after-reject");
        yield* t.setState("reconciliation-required");
        const refused = yield* Effect.flip(t.dispatch("cancel"));
        assert.include(refused.message, "can no longer be cancelled");
        // A Recheck proves the history unchanged and returns the rewind to prepared.
        yield* t.setState("prepared");
        yield* t.dispatch("cancel");
        assert.equal(yield* t.exists("rewind_operations"), false);
      }),
    );

    it.effect("rewind cancel: never discards a completed rewind draft", () =>
      Effect.gen(function* () {
        const t = yield* setup("cancel-completed");
        yield* t.setState("completed");
        const refused = yield* Effect.flip(t.dispatch("cancel"));
        assert.include(refused.message, "can no longer be cancelled");
        const row = (yield* t.sql<{
          resolved: string | null;
        }>`SELECT draft_resolved_at AS resolved FROM rewind_operations WHERE operation_id = ${t.operationId}`)[0]!;
        assert.equal(row.resolved, null);
      }),
    );

    it.effect("rewind cancel: a plain resolve does not cancel a prepared rewind", () =>
      Effect.gen(function* () {
        const t = yield* setup("resolve-prepared");
        yield* t.setState("prepared");
        const refused = yield* Effect.flip(t.dispatch());
        assert.include(refused.message, "This rewind draft is not ready.");
        assert.equal(yield* t.exists("rewind_operations"), true);
      }),
    );

    it.effect("rewind cancel: keeps a pause the rewind did not set", () =>
      Effect.gen(function* () {
        const t = yield* setup("cancel-keeps-other-pause");
        yield* t.setState("prepared");
        yield* t.pauseQueue("thread_reverted");
        yield* t.dispatch("cancel");
        assert.deepEqual(yield* t.queue, { paused: 1, reason: "thread_reverted" });
      }),
    );
  }
  it.effect("re-admits only a definitely rejected steer as a start using its original IDs", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("steer-fallback-engine");
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* NextTurnQueueStore;
      const commandId = CommandId.makeUnsafe("steer:fallback");
      const messageId = MessageId.makeUnsafe("steer:message");
      const command = {
        type: "thread.turn.start" as const,
        commandId,
        threadId,
        message: { messageId, role: "user" as const, text: "steer", attachments: [] },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: at,
      };
      // Begin an active turn through the regular persisted session command.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("busy:session"),
        threadId,
        createdAt: at,
        session: {
          threadId,
          providerName: "codex",
          status: "running",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("busy"),
          lastError: null,
          updatedAt: at,
        },
      });
      const mismatch = yield* engine
        .dispatch({
          ...command,
          commandId: CommandId.makeUnsafe("steer-wrong-model"),
          type: "thread.turn.steer",
          expectedTurnId: TurnId.makeUnsafe("busy"),
          model: "different-model",
        })
        .pipe(Effect.flip);
      assert.equal(mismatch._tag, "OrchestrationCommandInvariantError");
      assert.equal(
        (yield* engine.getReadModel()).threads.find((thread) => thread.id === threadId)?.model,
        "gpt-5-codex",
      );
      yield* store.insertSubmission({
        submissionId: commandId,
        itemId: commandId,
        requestHash: "steer",
        command: { ...command, expectedTurnId: TurnId.makeUnsafe("busy") },
        atHead: false,
      });
      yield* engine.dispatch({
        ...command,
        type: "thread.turn.steer",
        expectedTurnId: TurnId.makeUnsafe("busy"),
      });
      yield* sql`UPDATE provider_turn_deliveries SET state = 'rejected', certainty = 'not_sent' WHERE command_id = ${commandId}`;
      yield* store.fallbackSteer(commandId);
      yield* store.setSteer(
        commandId,
        (yield* store.listByThread(threadId)).state.revision,
        TurnId.makeUnsafe("busy"),
      );
      yield* engine.dispatch({
        ...command,
        type: "thread.turn.steer",
        expectedTurnId: TurnId.makeUnsafe("busy"),
      });
      const reissued = (yield* sql<{
        state: string;
        event: string;
      }>`SELECT state,event_json AS event FROM provider_turn_deliveries WHERE command_id = ${commandId}`)[0]!;
      assert.equal(reissued.state, "pending");
      assert.equal(JSON.parse(reissued.event).type, "thread.turn-steer-requested");
      yield* sql`UPDATE provider_turn_deliveries SET state = 'rejected', certainty = 'not_sent' WHERE command_id = ${commandId}`;
      yield* store.fallbackSteer(commandId);
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("idle:session"),
        threadId,
        createdAt: at,
        session: {
          threadId,
          providerName: "codex",
          status: "ready",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: at,
        },
      });
      yield* engine.dispatch(command);
      const deliveries = yield* sql<{
        state: string;
        event: string;
      }>`SELECT state, event_json AS event FROM provider_turn_deliveries WHERE command_id = ${commandId}`;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.state, "pending");
      assert.equal(JSON.parse(deliveries[0]!.event).type, "thread.turn-start-requested");
      const messages = (yield* engine.getReadModel()).threads.find(
        (thread) => thread.id === threadId,
      )!.messages;
      assert.equal(messages.filter((message) => message.id === messageId).length, 1);
      assert.equal(messages.find((message) => message.id === messageId)!.turnId, null);
    }),
  );
});
