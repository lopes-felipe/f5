import { WorkspaceTransitionsLive } from "../../persistence/Layers/WorkspaceTransitions.ts";
import {
  WorktreePreparation,
  type WorktreePreparationShape,
} from "../../project/Services/WorktreePreparation.ts";
import { RepositoryBusyError } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import * as fs from "node:fs/promises";
import { canonicalWorktreePath } from "../../git/worktreePaths.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OrchestrationThread, OrchestrationEvent } from "@t3tools/contracts";
import path from "node:path";
import os from "node:os";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { makeFakeGitCore } from "../../git/testDoubles.ts";
import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderTurnDeliveryRepository } from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import { RuntimeReceiptBus } from "../../orchestration/Services/RuntimeReceiptBus.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { withWorktreeLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import { NextTurnQueueDispatcher } from "../Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcherLive } from "./NextTurnQueueDispatcher.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

const dispatched: CommandId[] = [];
// Provider delivery rows keyed by command id, and the unresolved delivery that
// the repository's supersession rule reports per thread.
const deliveryRows = new Map<string, ReturnType<typeof deliveryRow>>();
const unresolvedDeliveries = new Map<string, unknown>();

const deliveryRow = (input: {
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly state: "accepted" | "rejected" | "ambiguous" | "abandoned";
}) => ({
  deliveryId: CommandId.makeUnsafe(input.commandId),
  commandId: CommandId.makeUnsafe(input.commandId),
  threadId: input.threadId,
  state: input.state,
  certainty: input.state === "ambiguous" ? "unknown" : null,
  errorDetail: null,
  event: { type: "thread.turn-start-requested" },
});

const makeDependencies = (
  worktreePath: string | null,
  resumeThread?: OrchestrationThread,
  beforeSessionRead: Effect.Effect<void> = Effect.void,
  domainEvents: Stream.Stream<OrchestrationEvent> = Stream.empty,
) =>
  Layer.mergeAll(
    Layer.succeed(ProjectionThreadRepository, {
      getById: ({ threadId }: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            threadId,
            archivedAt: null,
            deletedAt: null,
            worktreePath,
            branch: "feature",
            projectId: ProjectId.makeUnsafe("queue-dispatcher-project"),
          }),
        ),
    } as never),
    Layer.succeed(ProjectionThreadSessionRepository, {
      getByThreadId: () =>
        beforeSessionRead.pipe(
          Effect.andThen(
            Effect.succeed(
              resumeThread?.session
                ? Option.some({ ...resumeThread.session, threadId: resumeThread.id })
                : Option.none(),
            ),
          ),
        ),
    } as never),
    Layer.succeed(OrchestrationCommandReceiptRepository, {
      getByCommandId: () => Effect.succeed(Option.none()),
    } as never),
    Layer.succeed(ProviderTurnDeliveryRepository, {
      markAbandoned: (deliveryId: CommandId) =>
        Effect.sync(() => {
          const row = [...deliveryRows.values()].find((row) => row.deliveryId === deliveryId);
          if (!row || (row.state !== "rejected" && row.state !== "ambiguous")) return false;
          row.state = "abandoned";
          return true;
        }),
      getByCommandId: (commandId: CommandId) =>
        Effect.sync(() => deliveryRows.get(commandId) ?? null),
      getUnresolvedByThread: (threadId: ThreadId) =>
        Effect.sync(() => unresolvedDeliveries.get(threadId) ?? null),
    } as never),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: { readonly commandId: CommandId }) =>
        Effect.sync(() => {
          dispatched.push(command.commandId);
          return { sequence: dispatched.length };
        }),
      getReadModel: () =>
        Effect.succeed({
          threads: resumeThread ? [resumeThread] : [],
          projects: [
            { id: ProjectId.makeUnsafe("queue-dispatcher-project"), workspaceRoot: process.cwd() },
          ],
        }),
      streamDomainEvents: domainEvents,
    } as never),
    Layer.succeed(RuntimeReceiptBus, {
      publish: () => Effect.void,
      stream: Stream.empty,
    }),
  );

const persistence = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "f5-next-turn-dispatcher-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const storeLayer = NextTurnQueueStoreLive.pipe(Layer.provideMerge(persistence));
const makeTestLayer = (
  git: GitCoreShape = makeFakeGitCore().service,
  worktreePath: string | null = null,
  resumeThread?: OrchestrationThread,
  automatic?: boolean,
  beforeSessionRead?: Effect.Effect<void>,
  preparation?: WorktreePreparationShape,
  domainEvents?: Stream.Stream<OrchestrationEvent>,
) =>
  NextTurnQueueDispatcherLive.pipe(
    Layer.provideMerge(preparation ? Layer.succeed(WorktreePreparation, preparation) : Layer.empty),
    Layer.provide(Layer.succeed(GitCore, git)),
    Layer.provideMerge(ProjectionTurnRepositoryLive.pipe(Layer.provide(persistence))),
    Layer.provideMerge(storeLayer),
    Layer.provideMerge(
      makeDependencies(worktreePath, resumeThread, beforeSessionRead, domainEvents),
    ),
    Layer.provideMerge(
      automatic === undefined
        ? Layer.empty
        : ServerSettingsService.layerTest({ autoResumeUsageLimitedThreads: automatic }),
    ),
  );
const layer = it.layer(makeTestLayer());

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql`
      INSERT OR IGNORE INTO projection_projects (
        project_id, title, workspace_root, default_model, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES ('queue-dispatcher-project', 'Queue project', '/tmp', NULL, '[]', ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
        archived_at, created_at, last_interaction_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${ProjectId.makeUnsafe("queue-dispatcher-project")}, 'Queue thread',
        'gpt-5.1-codex', NULL, NULL, NULL, NULL, ${now}, ${now}, ${now}, NULL
      )
    `;
  });

it.effect("republishes the restored queue when rewind preflight fails", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    yield* Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("rewind-failed-publication");
      yield* seedThread(threadId);
      yield* store.setPaused({
        threadId,
        paused: true,
        reasonCode: "rewind_in_progress",
        detail: "Rewinding the conversation.",
      });
      yield* dispatcher.start;
      yield* dispatcher.drain;
      const before = yield* dispatcher.getSnapshot(threadId);
      assert.equal(before.reasonCode, "rewind_in_progress");
      const publication = yield* Stream.runHead(dispatcher.changes).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      // Rewind restores raw SQL before it emits its failure activity.
      yield* sql`UPDATE next_turn_queue_state SET pause_reason_code = 'manual_pause', pause_detail = 'User paused', revision = revision + 1 WHERE thread_id = ${threadId}`;
      const at = new Date().toISOString();
      yield* Queue.offer(events, {
        sequence: 1,
        eventId: EventId.makeUnsafe("rewind-failure-event"),
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: at,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          activity: {
            id: EventId.makeUnsafe("rewind-failure"),
            kind: "conversation.rewind.failed",
            tone: "error",
            summary: "Conversation rewind could not start",
            payload: {},
            turnId: null,
            createdAt: at,
          },
        },
      });
      assert.equal(Option.getOrThrow(yield* Fiber.join(publication)), threadId);
      const restored = yield* dispatcher.getSnapshot(threadId);
      assert.equal(restored.paused, true);
      assert.equal(restored.reasonCode, "manual_pause");
      assert.equal(restored.reasonDetail, "User paused");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          undefined,
          null,
          undefined,
          undefined,
          undefined,
          undefined,
          Stream.fromQueue(events),
        ),
      ),
    );
  }),
);

const insert = (index: number, threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* NextTurnQueueStore;
    return yield* store.insertSubmission({
      submissionId: CommandId.makeUnsafe(`dispatcher-submission-${index}`),
      requestHash: `dispatcher-hash-${index}`,
      itemId: CommandId.makeUnsafe(`dispatcher-item-${index}`),
      atHead: false,
      command: {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`dispatcher-command-${index}`),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(`dispatcher-message-${index}`),
          role: "user",
          text: `Turn ${index}`,
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.1-codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      },
    });
  });

const seedAcceptedPending = (threadId: ThreadId, withTurn: boolean) =>
  Effect.gen(function* () {
    const turns = yield* ProjectionTurnRepository;
    const sql = yield* SqlClient.SqlClient;
    const at = new Date().toISOString();
    const turnId = TurnId.makeUnsafe(`${threadId}-turn`);
    const messageId = MessageId.makeUnsafe(`${threadId}-message`);
    yield* turns.replacePendingTurnStart({
      threadId,
      messageId,
      requestedAt: at,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
    });
    yield* sql`INSERT INTO provider_turn_deliveries
    (delivery_id, thread_id, command_id, message_id, state, provider_turn_id, event_json, created_at, updated_at)
    VALUES (${threadId}, ${threadId}, ${threadId}, ${messageId}, 'accepted', ${turnId}, '{}', ${at}, ${at})`;
    if (withTurn) {
      yield* turns.upsertByTurnId({
        threadId,
        turnId,
        pendingMessageId: MessageId.makeUnsafe("original-message"),
        assistantMessageId: null,
        state: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        processingQuiescedAt: at,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
    }
  });

layer("NextTurnQueueDispatcher", (it) => {
  it.effect(
    "reconciles accepted feedback, waits for completion, then dispatches exactly once",
    () =>
      Effect.gen(function* () {
        dispatched.length = 0;
        const dispatcher = yield* NextTurnQueueDispatcher;
        const store = yield* NextTurnQueueStore;
        const turns = yield* ProjectionTurnRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("accepted-feedback-thread");
        const turnId = TurnId.makeUnsafe("existing-feedback-turn");
        const messageId = MessageId.makeUnsafe("feedback-message");
        const at = "2026-01-01T00:00:00.000Z";
        yield* seedThread(threadId);
        const submission = yield* insert(3, threadId);
        assert.equal(submission.kind, "created");
        const turn = {
          threadId,
          turnId,
          pendingMessageId: MessageId.makeUnsafe("original-message"),
          assistantMessageId: null,
          state: "running" as const,
          requestedAt: at,
          startedAt: at,
          completedAt: null,
          processingQuiescedAt: null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        };
        yield* turns.upsertByTurnId(turn);
        yield* turns.replacePendingTurnStart({
          threadId,
          messageId,
          requestedAt: at,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
        });
        yield* sql`INSERT INTO provider_turn_deliveries
        (delivery_id, thread_id, command_id, message_id, state, provider_turn_id,
         event_json, created_at, updated_at, outcome_projected_at)
        VALUES ('feedback-delivery', ${threadId}, 'feedback-command', ${messageId}, 'accepted',
          ${turnId}, '{}', ${at}, ${at}, ${at})`;

        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.deepEqual(dispatched, []);
        assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, "active_turn");
        assert.equal(Option.isNone(yield* turns.getPendingTurnStartByThreadId({ threadId })), true);

        const completedAt = new Date().toISOString();
        yield* turns.upsertByTurnId({ ...turn, state: "completed", completedAt });
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.deepEqual(dispatched, []);
        assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, "turn_post_processing");

        // Reproduce an existing false pause and stale placeholder from before the fix.
        yield* turns.replacePendingTurnStart({
          threadId,
          messageId,
          requestedAt: at,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
        });
        yield* turns.markProcessingQuiesced({
          threadId,
          turnId,
          processingQuiescedAt: completedAt,
        });
        yield* store.setPaused({ threadId, paused: true, reasonCode: "turn_never_started" });
        yield* store.setPaused({ threadId, paused: false });
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.deepEqual(dispatched, [CommandId.makeUnsafe("dispatcher-command-3")]);
        assert.equal((yield* store.listByThread(threadId)).state.paused, false);
        assert.equal(
          Option.getOrThrow(yield* turns.getByTurnId({ threadId, turnId })).pendingMessageId,
          turn.pendingMessageId,
        );
      }),
  );

  it.effect(
    "keeps snapshots available and the barrier intact when cleanup fails, then recovers",
    () =>
      Effect.gen(function* () {
        dispatched.length = 0;
        const dispatcher = yield* NextTurnQueueDispatcher;
        const turns = yield* ProjectionTurnRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("cleanup-failure-thread");
        yield* seedThread(threadId);
        yield* insert(4, threadId);
        yield* seedAcceptedPending(threadId, true);
        yield* sql`CREATE TRIGGER reject_pending_cleanup BEFORE DELETE ON projection_turns
        WHEN OLD.thread_id = 'cleanup-failure-thread' AND OLD.turn_id IS NULL
        BEGIN SELECT RAISE(FAIL, 'simulated cleanup write failure'); END`;
        try {
          assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, "turn_starting");
          yield* dispatcher.notify(threadId);
          yield* dispatcher.drain;
          assert.deepEqual(dispatched, []);
          assert.equal(
            Option.isSome(yield* turns.getPendingTurnStartByThreadId({ threadId })),
            true,
          );
        } finally {
          yield* sql`DROP TRIGGER reject_pending_cleanup`;
        }
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.deepEqual(dispatched, [CommandId.makeUnsafe("dispatcher-command-4")]);
      }),
  );

  it.effect("waits for turn projection even when the delivery is already accepted", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const dispatcher = yield* NextTurnQueueDispatcher;
      const threadId = ThreadId.makeUnsafe("missing-turn-thread");
      yield* seedThread(threadId);
      yield* insert(5, threadId);
      yield* seedAcceptedPending(threadId, false);
      assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, "turn_starting");
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      assert.deepEqual(dispatched, []);
      assert.equal((yield* dispatcher.getSnapshot(threadId)).paused, false);
    }),
  );

  it.effect("starts a project-root turn only while holding the project root's lifecycle lock", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const dispatcher = yield* NextTurnQueueDispatcher;
      const threadId = ThreadId.makeUnsafe("project-root-lock-thread");
      yield* seedThread(threadId);
      yield* insert(7, threadId);
      // Stands in for a default-branch auto-pull of the project root.
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* withWorktreeLifecycleLock(
        process.cwd(),
        Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      yield* dispatcher.notify(threadId);
      // Real time (it.effect uses a test clock) for the worker to reach the lock.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)));
      assert.deepEqual(dispatched, []);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* dispatcher.drain;
      assert.deepEqual(dispatched, [CommandId.makeUnsafe("dispatcher-command-7")]);
    }),
  );

  it.effect(
    "does not attempt cleanup writes on snapshots or dispatch without a pending placeholder",
    () =>
      Effect.gen(function* () {
        dispatched.length = 0;
        const dispatcher = yield* NextTurnQueueDispatcher;
        const turns = yield* ProjectionTurnRepository;
        const threadId = ThreadId.makeUnsafe("no-pending-thread");
        yield* seedThread(threadId);
        yield* insert(6, threadId);
        const cleanup = vi.spyOn(turns, "reconcileAcceptedPendingTurnStarts");
        try {
          assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, null);
          yield* dispatcher.notify(threadId);
          yield* dispatcher.drain;
          assert.deepEqual(dispatched, [CommandId.makeUnsafe("dispatcher-command-6")]);
          assert.equal(cleanup.mock.calls.length, 0);
        } finally {
          cleanup.mockRestore();
        }
      }),
  );

  it.effect(
    "retires rejected buffered native continuations while preserving human items and ambiguous deliveries",
    () =>
      Effect.gen(function* () {
        const dispatcher = yield* NextTurnQueueDispatcher;
        const store = yield* NextTurnQueueStore;
        for (const [index, state] of (["rejected", "ambiguous"] as const).entries()) {
          const threadId = ThreadId.make(`native-${state}`);
          yield* seedThread(threadId);
          const native = yield* insert(100 + 2 * index, threadId);
          const human = yield* insert(101 + 2 * index, threadId);
          if (native.kind !== "created" || human.kind !== "created")
            throw new Error("Expected queued fixtures.");
          const edited = yield* store.updateCommand({
            itemId: native.item.itemId,
            expectedUpdatedAt: native.item.updatedAt,
            update: (command) => ({ ...command, continuationRequestId: command.commandId }),
          });
          deliveryRows.set(
            edited.command.commandId,
            deliveryRow({ commandId: edited.command.commandId, threadId, state }),
          );
          yield* dispatcher.handleDeliveryOutcome({
            deliveryId: edited.command.commandId,
            commandId: edited.command.commandId,
            threadId,
            state,
            detail: "Native fixture ended",
          });
          const queue = yield* store.listByThread(threadId);
          assert.equal(
            queue.items.some((item) => item.itemId === human.item.itemId),
            true,
          );
          assert.equal(
            queue.items.some((item) => item.itemId === native.item.itemId),
            state === "ambiguous",
          );
          assert.equal(
            deliveryRows.get(edited.command.commandId)?.state,
            state === "ambiguous" ? "ambiguous" : "abandoned",
          );
          assert.equal(queue.state.paused, state === "ambiguous");
          yield* store.clear({ threadId, scope: "all", expectedRevision: queue.state.revision });
          deliveryRows.delete(edited.command.commandId);
        }
        yield* dispatcher.drain;
        dispatched.length = 0;
      }),
  );

  it.effect("does not admit a later item after Resume while delivery recovery is unresolved", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-delivery-recovery-thread");
      yield* seedThread(threadId);
      const first = yield* insert(1, threadId);
      const second = yield* insert(2, threadId);
      if (first.kind !== "created" || second.kind !== "created") return;

      yield* store.markDeliveryFailed({
        commandId: first.item.command.commandId,
        errorCode: "delivery_rejected",
        errorDetail: "Provider rejected the first turn.",
      });
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;

      let queue = yield* store.listByThread(threadId);
      assert.deepEqual(dispatched, []);
      assert.equal(queue.state.paused, true);
      assert.equal(queue.state.pauseReasonCode, "delivery_rejected");
      assert.equal(queue.items[1]?.itemId, second.item.itemId);

      const promoteError = yield* dispatcher
        .promote({
          itemId: first.item.itemId,
          interruptActive: true,
          expectedRevision: queue.state.revision,
        })
        .pipe(Effect.flip);
      assert.match(promoteError.message, /Recheck, Retry, or Discard/u);

      // A generic Resume must not skip the failed head. Only an explicit
      // delivery recovery action may release the following turn.
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      assert.deepEqual(dispatched, []);

      yield* store.discardDelivery({ commandId: first.item.command.commandId });
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      queue = yield* store.listByThread(threadId);
      assert.deepEqual(dispatched, [second.item.command.commandId]);
      assert.equal(queue.items[0]?.status, "dispatching");
    }),
  );

  it.effect("clears a delivery pause once a newer accepted delivery supersedes it", () =>
    Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-superseded-delivery-thread");
      yield* seedThread(threadId);
      // An ambiguous direct send paused the queue; a later "continue" was then
      // accepted, so the repository no longer reports an unresolved delivery.
      yield* store.setPaused({
        threadId,
        paused: true,
        reasonCode: "delivery_ambiguous",
        detail: "The provider delivery outcome is unknown.",
      });
      deliveryRows.set(
        "superseded-continue",
        deliveryRow({ commandId: "superseded-continue", threadId, state: "accepted" }),
      );
      assert.equal((yield* dispatcher.getSnapshot(threadId)).unresolvedDelivery, null);

      yield* dispatcher.handleDeliveryOutcome({
        deliveryId: CommandId.makeUnsafe("superseded-continue"),
        commandId: CommandId.makeUnsafe("superseded-continue"),
        threadId,
        state: "accepted",
        detail: null,
      });

      const snapshot = yield* dispatcher.getSnapshot(threadId);
      assert.equal(snapshot.paused, false);
      assert.equal(snapshot.reasonCode, null);
      assert.equal(snapshot.unresolvedDelivery, null);
    }),
  );

  it.effect("keeps a delivery pause and reports the delivery while it is unresolved", () =>
    Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-unresolved-delivery-thread");
      yield* seedThread(threadId);
      yield* store.setPaused({ threadId, paused: true, reasonCode: "delivery_ambiguous" });
      unresolvedDeliveries.set(
        threadId,
        deliveryRow({ commandId: "unresolved-author", threadId, state: "ambiguous" }),
      );

      yield* dispatcher.reconcileDeliveryPause(threadId);

      const snapshot = yield* dispatcher.getSnapshot(threadId);
      assert.equal(snapshot.paused, true);
      assert.deepEqual(snapshot.unresolvedDelivery, {
        deliveryId: CommandId.makeUnsafe("unresolved-author"),
        state: "ambiguous",
      });
      unresolvedDeliveries.delete(threadId);
    }),
  );

  it.effect("targets a failed queue item's own delivery even after it is superseded", () =>
    Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const threadId = ThreadId.makeUnsafe("queue-superseded-item-thread");
      yield* seedThread(threadId);
      const created = yield* insert(31, threadId);
      if (created.kind !== "created") return;
      const commandId = created.item.command.commandId;
      yield* store.markDeliveryFailed({
        commandId,
        errorCode: "delivery_ambiguous",
        errorDetail: "The provider delivery outcome is unknown.",
      });
      yield* store.setPaused({ threadId, paused: true, reasonCode: "delivery_ambiguous" });
      deliveryRows.set(commandId, deliveryRow({ commandId, threadId, state: "ambiguous" }));

      const blocking = yield* dispatcher.getBlockingDelivery(threadId);
      assert.equal(blocking?.deliveryId, commandId);
      yield* dispatcher.reconcileDeliveryPause(threadId);
      assert.equal((yield* store.listByThread(threadId)).state.paused, true);

      // Once Recheck proves the delivery, the failed item completes and the
      // pause clears without any manual database repair.
      deliveryRows.set(commandId, deliveryRow({ commandId, threadId, state: "accepted" }));
      yield* dispatcher.reconcileDeliveryPause(threadId);
      const queue = yield* store.listByThread(threadId);
      assert.equal(queue.items.length, 0);
      assert.equal(queue.state.paused, false);
      deliveryRows.delete(commandId);
    }),
  );
});

for (const scenario of [
  "recoverable",
  "preparing",
  "missing-ref",
  "checked-out-elsewhere",
  "repository-busy",
  "inspection-error",
] as const) {
  it.effect(`handles a missing worktree before queue dispatch: ${scenario}`, () => {
    const target = path.join(os.tmpdir(), `f5-missing-${crypto.randomUUID()}`);
    const registration = () =>
      Effect.promise(async () => ({
        path: target,
        canonicalPath: await canonicalWorktreePath(target),
        branch: "feature",
        headSha: "abc123",
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
        isMain: false,
      }));
    let backgroundPreparations = 0;
    const preparation: WorktreePreparationShape | undefined =
      scenario === "preparing"
        ? {
            startup: Effect.void,
            needsPreparation: () => Effect.succeed(true),
            prepare: () =>
              Effect.die("Preparation scripts must never run on the dispatcher shard."),
            startBackground: () =>
              Effect.sync(() => {
                backgroundPreparations++;
              }),
          }
        : undefined;
    let busy = scenario === "repository-busy";
    let unreadable = scenario === "inspection-error";
    const git = makeFakeGitCore({
      listWorktrees: () =>
        unreadable
          ? Effect.fail(
              new GitCommandError({
                operation: "inspect",
                cwd: target,
                command: "git worktree list",
                detail: "unreadable metadata",
              }),
            )
          : registration().pipe(Effect.map((entry) => [entry])),
      inspectCheckout: () =>
        Effect.gen(function* () {
          const entry = yield* registration();
          return {
            canonicalRoot: entry.canonicalPath,
            commonDir: yield* Effect.promise(() => canonicalWorktreePath(`${process.cwd()}/.git`)),
            registration: entry,
            headSha: "abc123",
            branch: "feature",
            operation: null,
            hasInitializedSubmodules: false,
            hasTrackedChanges: false,
            hasUntrackedChanges: false,
            ignoredEntries: [],
            ignoredTruncated: false,
            upstreamRef: null,
            upstreamSha: null,
            aheadCount: null,
            behindCount: null,
          };
        }),
      branchExists: () => Effect.succeed(scenario !== "missing-ref"),
      ensureWorktree: () =>
        busy
          ? Effect.fail(
              new GitCommandError({
                operation: "ensureWorktree",
                cwd: process.cwd(),
                command: "git worktree add",
                detail: "Repository busy",
                cause: new RepositoryBusyError({ message: "Repository busy" }),
              }),
            )
          : scenario === "checked-out-elsewhere"
            ? Effect.fail(
                new GitCommandError({
                  operation: "ensureWorktree",
                  cwd: process.cwd(),
                  command: "git worktree add",
                  detail: "Branch feature is checked out at another-worktree.",
                }),
              )
            : Effect.promise(() => fs.mkdir(target, { recursive: true })).pipe(
                Effect.as({ recreated: true }),
              ),
    });
    return Effect.gen(function* () {
      dispatched.length = 0;
      const dispatcher = yield* NextTurnQueueDispatcher;
      const threadId = ThreadId.makeUnsafe(`queue-worktree-${scenario}`);
      yield* seedThread(threadId);
      yield* insert(1, threadId);
      const before = yield* dispatcher.getSnapshot(threadId);
      assert.equal(git.calls.ensureWorktree.length, 0);
      if (scenario === "recoverable") assert.equal(before.reasonCode, null);
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      const queue = yield* (yield* NextTurnQueueStore).listByThread(threadId);
      if (scenario === "recoverable") {
        assert.equal(dispatched.length, 1);
        assert.equal(git.calls.ensureWorktree.length, 1);
      } else if (scenario === "preparing") {
        assert.equal(backgroundPreparations, 1);
        assert.equal(dispatched.length, 0);
        assert.equal(queue.state.paused, false);
        assert.equal(queue.items[0]?.status, "queued");
        assert.equal(git.calls.initializeWorktreeSubmodules.length, 0);
      } else if (scenario === "inspection-error") {
        assert.equal(queue.state.paused, false);
        // Reading snapshots must not consume the worker's bounded retry budget.
        for (let i = 0; i < 10; i++) yield* dispatcher.getSnapshot(threadId);
        for (let i = 0; i < 4; i++) {
          yield* dispatcher.notify(threadId);
          yield* dispatcher.drain;
        }
        const store = yield* NextTurnQueueStore;
        const paused = yield* store.listByThread(threadId);
        assert.equal(paused.state.pauseReasonCode, "worktree_missing");
        assert.equal(paused.state.paused, true);
        assert.equal(dispatched.length, 0);
        unreadable = false;
        yield* store.setPaused({
          threadId,
          paused: false,
          expectedRevision: paused.state.revision,
        });
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.equal(dispatched.length, 1);
      } else if (scenario === "repository-busy") {
        assert.equal(dispatched.length, 0);
        assert.equal(queue.state.paused, false);
        busy = false;
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.equal(dispatched.length, 1);
      } else {
        assert.equal(dispatched.length, 0);
        assert.equal(queue.state.pauseReasonCode, "worktree_missing");
        if (scenario === "checked-out-elsewhere")
          assert.match(queue.state.pauseDetail ?? "", /checked out at/);
      }
    }).pipe(
      Effect.provide(
        makeTestLayer(git.service, target, undefined, undefined, undefined, preparation),
      ),
      Effect.ensuring(Effect.promise(() => fs.rm(target, { recursive: true, force: true }))),
    );
  });
}

for (const steering of [true, false]) {
  it.effect(`lets only steers into the live turn through branch drift: ${steering}`, () => {
    const target = path.join(os.tmpdir(), `f5-drift-${crypto.randomUUID()}`);
    const threadId = ThreadId.makeUnsafe(`queue-drift-${steering}`);
    const liveTurn = TurnId.makeUnsafe("live-turn");
    const thread = {
      id: threadId,
      projectId: ProjectId.makeUnsafe("queue-dispatcher-project"),
      deletedAt: null,
      archivedAt: null,
      pendingUserInputs: [],
      session: {
        threadId,
        providerInstanceId: "codex",
        status: steering ? "running" : "ready",
        activeTurnId: steering ? liveTurn : null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    } as unknown as OrchestrationThread;
    // The agent switched the recorded `feature` worktree to another branch.
    const git = makeFakeGitCore({
      listWorktrees: () =>
        Effect.promise(async () => [
          {
            path: target,
            canonicalPath: await canonicalWorktreePath(target),
            branch: "agent-branch",
            headSha: "abc123",
            bare: false,
            detached: false,
            locked: null,
            prunable: null,
            isMain: false,
          },
        ]),
      inspectCheckout: () =>
        Effect.promise(async () => ({
          canonicalRoot: await canonicalWorktreePath(target),
          commonDir: await canonicalWorktreePath(`${process.cwd()}/.git`),
          branch: "agent-branch",
        })) as never,
    });
    return Effect.gen(function* () {
      dispatched.length = 0;
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }));
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      yield* seedThread(threadId);
      yield* insert(70, threadId);
      if (steering) {
        const sql = yield* SqlClient.SqlClient;
        const item = (yield* store.listByThread(threadId)).items[0]!;
        yield* sql`UPDATE next_turn_queue SET command_json = ${JSON.stringify({
          ...item.command,
          expectedTurnId: liveTurn,
        })} WHERE item_id = ${item.itemId}`;
      }
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      const queue = yield* store.listByThread(threadId);
      if (steering) {
        assert.equal(dispatched.length, 1);
        assert.equal(queue.state.paused, false);
      } else {
        assert.equal(dispatched.length, 0);
        assert.equal(queue.state.paused, true);
        assert.equal(queue.state.pauseReasonCode, "worktree_missing");
      }
    }).pipe(
      Effect.provide(makeTestLayer(git.service, target, thread)),
      Effect.ensuring(Effect.promise(() => fs.rm(target, { recursive: true, force: true }))),
    );
  });
}

for (const automatic of [false, true]) {
  it.effect(`schedules reset recovery at startup only when opted in: ${automatic}`, () => {
    const threadId = ThreadId.makeUnsafe(`recovery-startup-${automatic}`);
    const resetsAt = new Date(Date.now() + 2000).toISOString();
    const thread = {
      id: threadId,
      projectId: ProjectId.makeUnsafe("queue-dispatcher-project"),
      deletedAt: null,
      archivedAt: null,
      model: "gpt-5.1-codex",
      runtimeMode: "approval-required",
      interactionMode: "default",
      pendingUserInputs: [],
      session: {
        threadId,
        providerInstanceId: "codex",
        status: "error",
        activeTurnId: null,
        lastError: "Usage limit reached",
        updatedAt: new Date().toISOString(),
        usageLimit: {
          providerInstanceId: "codex",
          turnId: "blocked-turn",
          deliveryId: null,
          windows: [{ id: "five_hour", label: "5-hour", resetsAt }],
          resetsAt,
          resetSource: "provider",
          evidence: "typed",
        },
      },
    } as unknown as OrchestrationThread;
    return Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* NextTurnQueueDispatcher;
        const store = yield* NextTurnQueueStore;
        yield* seedThread(threadId);
        yield* dispatcher.start;
        yield* dispatcher.drain;
        const snapshot = yield* dispatcher.getSnapshot(threadId);
        assert.equal(snapshot.items.length, automatic ? 1 : 0);
        if (!automatic) return;
        assert.equal(snapshot.reasonCode, "usage_limit_reset");
        assert.equal(
          snapshot.items[0]?.notBefore,
          new Date(Date.parse(resetsAt) + 60_000).toISOString(),
        );
        assert.equal(snapshot.items[0]?.command.message.text, "continue");
        assert.equal(snapshot.items[0]?.command.expectedTurnId, undefined);
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.equal((yield* store.listByThread(threadId)).items.length, 1);
        const result = yield* dispatcher.cancelUsageLimitResume({
          threadId,
          itemId: snapshot.items[0]!.itemId,
          expectedRevision: (yield* store.listByThread(threadId)).state.revision,
        });
        assert.equal(result.kind, "cancelled");
        assert.equal((yield* store.getUsageResumeLedger(threadId))?.state, "cancelled");
      }),
    ).pipe(Effect.provide(makeTestLayer(makeFakeGitCore().service, null, thread, automatic)));
  });
}

it.effect("does not undo a recovery scheduled while a stale auto-pause gate is being read", () =>
  Effect.gen(function* () {
    const gateEntered = yield* Deferred.make<void>();
    const releaseGate = yield* Deferred.make<void>();
    let firstRead = true;
    const beforeSessionRead = Effect.gen(function* () {
      if (!firstRead) return;
      firstRead = false;
      yield* Deferred.succeed(gateEntered, undefined);
      yield* Deferred.await(releaseGate);
    });
    const threadId = ThreadId.makeUnsafe("recovery-stale-auto-pause");
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    const thread = {
      id: threadId,
      projectId: ProjectId.makeUnsafe("queue-dispatcher-project"),
      deletedAt: null,
      archivedAt: null,
      model: "gpt-5.1-codex",
      runtimeMode: "approval-required",
      interactionMode: "default",
      pendingUserInputs: [],
      session: {
        threadId,
        providerInstanceId: "codex",
        status: "error",
        activeTurnId: null,
        lastError: "Usage limit reached",
        updatedAt: new Date().toISOString(),
        usageLimit: {
          providerInstanceId: "codex",
          turnId: "blocked-turn",
          deliveryId: null,
          windows: [],
          resetsAt,
          resetSource: "provider",
          evidence: "typed",
        },
      },
    } as unknown as OrchestrationThread;
    yield* Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      yield* seedThread(threadId);
      yield* insert(901, threadId);
      const original = (yield* store.listByThread(threadId)).items[0]!;
      yield* dispatcher.notify(threadId);
      yield* Deferred.await(gateEntered);
      // The dispatcher has read the old queue revision, but its session read
      // cannot finish until this recovery transaction commits.
      const recoveryId = CommandId.makeUnsafe("stale-pause-recovery");
      yield* store.scheduleUsageLimitResume({
        itemId: recoveryId,
        submissionId: recoveryId,
        requestHash: "stale-pause-recovery",
        command: {
          ...original.command,
          commandId: recoveryId,
          message: {
            ...original.command.message,
            messageId: MessageId.makeUnsafe("stale-pause-recovery-message"),
            text: "continue",
          },
          presentation: "continuation",
        },
        limitKey: "instance:codex:turn:blocked-turn",
        providerInstanceId: "codex",
        source: "manual",
        notBefore: resetsAt,
      });
      yield* Deferred.succeed(releaseGate, undefined);
      yield* dispatcher.drain;
      const queue = yield* store.listByThread(threadId);
      assert.equal(queue.state.paused, false);
      assert.equal(queue.items[0]?.itemId, recoveryId);
      assert.equal((yield* dispatcher.getSnapshot(threadId)).reasonCode, "usage_limit_reset");
    }).pipe(
      Effect.provide(
        makeTestLayer(makeFakeGitCore().service, null, thread, undefined, beforeSessionRead),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("promotes reset recovery once and returns already-sending on cancellation", () => {
  const threadId = ThreadId.makeUnsafe("recovery-promote");
  const resetsAt = new Date(Date.now() + 60_000).toISOString();
  const thread = {
    id: threadId,
    projectId: ProjectId.makeUnsafe("queue-dispatcher-project"),
    deletedAt: null,
    archivedAt: null,
    model: "gpt-5.1-codex",
    runtimeMode: "approval-required",
    interactionMode: "default",
    pendingUserInputs: [],
    session: {
      threadId,
      providerInstanceId: "codex",
      status: "error",
      activeTurnId: null,
      lastError: "Usage limit reached",
      updatedAt: new Date().toISOString(),
      usageLimit: {
        providerInstanceId: "codex",
        turnId: "blocked-turn",
        deliveryId: null,
        windows: [],
        resetsAt,
        resetSource: "provider",
        evidence: "typed",
      },
    },
  } as unknown as OrchestrationThread;
  return Effect.gen(function* () {
    dispatched.length = 0;
    const dispatcher = yield* NextTurnQueueDispatcher;
    const store = yield* NextTurnQueueStore;
    yield* seedThread(threadId);
    const snapshot = yield* dispatcher.scheduleUsageLimitResume({
      threadId,
      expectedLimitKey: "instance:codex:turn:blocked-turn",
      source: "manual",
    });
    yield* dispatcher.drain;
    assert.equal(dispatched.length, 0);
    yield* dispatcher.promote({
      itemId: snapshot.items[0]!.itemId,
      expectedRevision: (yield* store.listByThread(threadId)).state.revision,
      interruptActive: false,
    });
    yield* dispatcher.drain;
    assert.equal(dispatched.length, 1);
    const queue = yield* store.listByThread(threadId);
    assert.equal(queue.items[0]?.notBefore, null);
    const cancelled = yield* dispatcher.cancelUsageLimitResume({
      threadId,
      itemId: queue.items[0]!.itemId,
      expectedRevision: queue.state.revision,
    });
    assert.equal(cancelled.kind, "already_sending");
    yield* dispatcher.notify(threadId);
    yield* dispatcher.drain;
    assert.equal(dispatched.length, 1);
  }).pipe(Effect.provide(makeTestLayer(makeFakeGitCore().service, null, thread)));
});

it.layer(
  makeTestLayer().pipe(
    Layer.provideMerge(WorkspaceTransitionsLive.pipe(Layer.provide(persistence))),
  ),
)("workspace transition queue barrier", (it) => {
  it.effect("promotion and Resume cannot clear a durable transition or admit later work", () =>
    Effect.gen(function* () {
      const dispatcher = yield* NextTurnQueueDispatcher;
      const store = yield* NextTurnQueueStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("transition-barrier-queue");
      dispatched.length = 0;
      yield* seedThread(threadId);
      yield* insert(90, threadId);
      const checkout = {
        path: process.cwd(),
        repository: path.join(process.cwd(), ".git"),
        branch: "feature",
        headSha: "head",
      };
      const record = {
        operationId: "transition-barrier",
        threadId,
        version: 3,
        intent: "checkout_branch",
        phase: "needs_recovery",
        source: checkout,
        target: { ...checkout, branch: "topic" },
        observed: null,
        result: null,
        error: "Inspect the interrupted switch.",
        request: {
          operationId: "transition-barrier",
          threadId,
          intent: "checkout_branch",
          branch: "topic",
          expected: { branch: null, worktreePath: null, sessionUpdatedAt: null },
        },
        requestHash: "hash",
        fingerprint: null,
        mutationAttempted: true,
        commandId: "workspace:barrier",
        setupOwnerToken: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      yield* sql`INSERT INTO workspace_transitions(operation_id,thread_id,request_hash,phase,version,record_json,created_at,updated_at) VALUES ('transition-barrier',${threadId},'hash','needs_recovery',3,${JSON.stringify(record)},${record.createdAt},${record.updatedAt})`;
      yield* dispatcher.start;
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      assert.deepEqual(dispatched, []);
      const before = yield* store.listByThread(threadId);
      yield* dispatcher.promote({
        itemId: CommandId.makeUnsafe("dispatcher-item-90"),
        interruptActive: false,
        expectedRevision: before.state.revision,
      });
      yield* store.setPaused({ threadId, paused: false });
      yield* dispatcher.notify(threadId);
      yield* dispatcher.drain;
      const snapshot = yield* dispatcher.getSnapshot(threadId);
      assert.equal(snapshot.reasonCode, "workspace_switch_failed");
      assert.equal(snapshot.workspaceTransition?.operationId, "transition-barrier");
      assert.deepEqual(dispatched, []);
      assert.equal((yield* insert(91, threadId).pipe(Effect.exit))._tag, "Failure");
      assert.equal(
        (yield* store.setWorktreeBlockToken({ threadId, token: "setup-retry" }).pipe(Effect.exit))
          ._tag,
        "Failure",
      );
    }),
  );
});

it.effect("starts every actionable page before the first safety-sweep interval", () =>
  Effect.gen(function* () {
    const dispatcher = yield* NextTurnQueueDispatcher;
    const store = yield* NextTurnQueueStore;
    const expected = new Set<CommandId>();
    for (let index = 0; index < 130; index++) {
      const threadId = ThreadId.makeUnsafe(`startup-page-${String(index).padStart(3, "0")}`);
      yield* seedThread(threadId);
      yield* insert(20_000 + index, threadId);
      expected.add(CommandId.makeUnsafe(`dispatcher-command-${20_000 + index}`));
    }
    const periodic = yield* store.listActionableThreadIds;
    assert.equal(periodic.length, 64);
    yield* dispatcher.start;
    yield* dispatcher.drain;
    assert.equal(dispatched.filter((id) => expected.has(id)).length, 130);
  }).pipe(Effect.provide(makeTestLayer())),
);

it.live(
  "notification before notBefore reinstates the precise wakeup without waiting for a sweep",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* NextTurnQueueDispatcher;
        const store = yield* NextTurnQueueStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("not-before-notified");
        yield* seedThread(threadId);
        yield* insert(9998, threadId);
        const item = (yield* store.listByThread(threadId)).items[0]!;
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const at = Date.now();
        yield* sql`UPDATE next_turn_queue SET not_before = ${new Date(at + 200).toISOString()} WHERE item_id = ${item.itemId}`;
        const before = dispatched.length;
        // Do not start the sweep: progress must come from the scheduled retry alone.
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.equal(dispatched.length, before);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(40));
        yield* dispatcher.notify(threadId);
        yield* dispatcher.drain;
        assert.equal(dispatched.length, before);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(160));
        yield* dispatcher.drain;
        assert.equal(dispatched.length, before + 1);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())), Effect.provide(makeTestLayer())),
);
