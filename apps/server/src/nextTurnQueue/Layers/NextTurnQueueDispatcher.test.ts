import { CommandId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, Layer, Option, Stream } from "effect";
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
import { NextTurnQueueDispatcher } from "../Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../Services/NextTurnQueueStore.ts";
import { NextTurnQueueDispatcherLive } from "./NextTurnQueueDispatcher.ts";
import { NextTurnQueueStoreLive } from "./NextTurnQueueStore.ts";

const dispatched: CommandId[] = [];

const dependencies = Layer.mergeAll(
  Layer.succeed(ProjectionThreadRepository, {
    getById: ({ threadId }: { threadId: ThreadId }) =>
      Effect.succeed(
        Option.some({ threadId, archivedAt: null, deletedAt: null, worktreePath: null }),
      ),
  } as never),
  Layer.succeed(ProjectionThreadSessionRepository, {
    getByThreadId: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(OrchestrationCommandReceiptRepository, {
    getByCommandId: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(ProviderTurnDeliveryRepository, {
    getByCommandId: () => Effect.succeed(null),
  } as never),
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: { readonly commandId: CommandId }) =>
      Effect.sync(() => {
        dispatched.push(command.commandId);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.empty,
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
const testLayer = NextTurnQueueDispatcherLive.pipe(
  Layer.provideMerge(ProjectionTurnRepositoryLive.pipe(Layer.provide(persistence))),
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(dependencies),
);
const layer = it.layer(testLayer);

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
});
