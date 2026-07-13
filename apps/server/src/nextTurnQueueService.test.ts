import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  type NextTurnQueueSnapshot,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { makeNextTurnQueueStore } from "./nextTurnQueue.ts";
import { makeNextTurnQueueService } from "./nextTurnQueueService.ts";
import { createEmptyReadModel } from "./orchestration/projector.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { makeProviderTurnIntentReceiptStore } from "./providerTurnIntentReceipts.ts";

const layer = it.layer(SqlitePersistenceMemory);
const threadId = ThreadId.makeUnsafe("queue-service-thread");
const createdAt = "2026-01-01T00:00:00.000Z";

function command(): ThreadTurnStartCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("queue-service-command"),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe("queue-service-message"),
      role: "user",
      text: "Run next",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt,
  };
}

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: "queue-service-project" as OrchestrationThread["projectId"],
    title: "Queue service thread",
    model: "gpt-5.1-codex",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    proposedPlans: [],
    compaction: null,
    sessionNotes: null,
    threadReferences: [],
    session: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    createdAt,
    updatedAt: createdAt,
    lastInteractionAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function readModel(currentThread: OrchestrationThread): OrchestrationReadModel {
  return { ...createEmptyReadModel(createdAt), threads: [currentThread] };
}

layer("NextTurnQueueService", (it) => {
  it.effect("derives a worktree_missing blocker without pausing the durable item", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const receipts = yield* makeProviderTurnIntentReceiptStore("queue-service-test");
      const scope = yield* Scope.make("sequential");
      const currentThread = thread({ worktreePath: "/missing/worktree" });
      const service = yield* makeNextTurnQueueService({
        store,
        receipts,
        scope,
        getReadModel: () => Effect.succeed(readModel(currentThread)),
        worktreeExists: () => Effect.succeed(false),
        dispatch: () => Effect.void,
        retryTurnStart: () => Effect.succeed(false),
        publishSnapshot: () => Effect.void,
        cleanupAttachments: () => Effect.void,
        cleanupAttachmentPaths: () => Effect.void,
      });

      yield* store.enqueue({
        itemId: CommandId.makeUnsafe("queue-service-worktree-item"),
        command: command(),
      });
      const snapshot = yield* service.getSnapshot(threadId);

      assert.equal(snapshot.blocker?.code, "worktree_missing");
      assert.equal(snapshot.items[0]?.status, "queued");
      yield* store.purgeThread(threadId);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("publishes and versions lifecycle changes only when the blocker changes", () =>
    Effect.gen(function* () {
      const store = yield* makeNextTurnQueueStore;
      const receipts = yield* makeProviderTurnIntentReceiptStore("queue-service-lifecycle-test");
      const scope = yield* Scope.make("sequential");
      let currentThread = thread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("queue-service-active-turn"),
          state: "running",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const published: NextTurnQueueSnapshot[] = [];
      const service = yield* makeNextTurnQueueService({
        store,
        receipts,
        scope,
        getReadModel: () => Effect.succeed(readModel(currentThread)),
        worktreeExists: () => Effect.succeed(true),
        dispatch: () => Effect.void,
        retryTurnStart: () => Effect.succeed(false),
        publishSnapshot: (snapshot) => Effect.sync(() => published.push(snapshot)),
        cleanupAttachments: () => Effect.void,
        cleanupAttachmentPaths: () => Effect.void,
      });

      const enqueued = yield* service.enqueue({
        itemId: CommandId.makeUnsafe("queue-service-lifecycle-item"),
        command: command(),
      });
      yield* service.handleThreadLifecycle(threadId, false);
      const unchanged = yield* store.getSnapshot(threadId);
      assert.equal(unchanged.version, enqueued.version);
      assert.equal(published.length, 1);

      currentThread = thread();
      yield* service.handleThreadLifecycle(threadId, false);
      const changed = yield* store.getSnapshot(threadId);
      assert.equal(changed.version, enqueued.version + 1);
      assert.equal(published.at(-1)?.blocker, null);
      assert.equal(published.length, 2);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
