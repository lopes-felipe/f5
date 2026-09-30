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
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
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
const question = (threadId: ThreadId, message = true) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const requestId = ApprovalRequestId.makeUnsafe(`question:${threadId}`);
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`ask:${threadId}`),
      threadId,
      createdAt: at,
      activity: {
        id: EventId.makeUnsafe(`ask:${threadId}`),
        kind: "user-input.requested",
        tone: "info",
        summary: "Question",
        turnId: TurnId.makeUnsafe("old-turn"),
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
