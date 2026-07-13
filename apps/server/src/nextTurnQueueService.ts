import type {
  ChatAttachment,
  CommandId,
  NextTurnQueueCancelInput,
  NextTurnQueueClearInput,
  NextTurnQueueReorderInput,
  NextTurnQueueResumeInput,
  NextTurnQueueSnapshot,
  NextTurnQueueUpdateInput,
  OrchestrationReadModel,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Queue, type Scope } from "effect";

import type { NextTurnQueueStore } from "./nextTurnQueue.ts";
import { drainNextTurnQueue, resolveNextTurnQueueGate } from "./nextTurnQueueDrainer.ts";
import type { ProviderTurnIntentReceiptStore } from "./providerTurnIntentReceipts.ts";

export interface NextTurnQueueServiceDependencies<SnapshotError, DispatchError, RetryError> {
  readonly store: NextTurnQueueStore;
  readonly receipts: ProviderTurnIntentReceiptStore;
  readonly scope: Scope.Scope;
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel, SnapshotError>;
  readonly worktreeExists: (worktreePath: string) => Effect.Effect<boolean, never>;
  readonly dispatch: (command: ThreadTurnStartCommand) => Effect.Effect<unknown, DispatchError>;
  readonly retryTurnStart: (commandId: CommandId) => Effect.Effect<boolean, RetryError>;
  readonly publishSnapshot: (snapshot: NextTurnQueueSnapshot) => Effect.Effect<void>;
  readonly cleanupAttachments: (attachments: ReadonlyArray<ChatAttachment>) => Effect.Effect<void>;
  readonly cleanupAttachmentPaths: (attachmentPaths: ReadonlyArray<string>) => Effect.Effect<void>;
}

/**
 * Owns the durable queue lifecycle. Transport adapters should normalize input,
 * then delegate state transitions here so scheduling, publication, and file
 * ownership cannot diverge between call sites.
 */
export function makeNextTurnQueueService<SnapshotError, DispatchError, RetryError>(
  input: NextTurnQueueServiceDependencies<SnapshotError, DispatchError, RetryError>,
) {
  return Effect.gen(function* () {
    const wakeQueue = yield* Queue.sliding<void>(1);
    const wake = Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);
    const publishedBlockerKeys = new Map<ThreadId, string>();

    const blockerKey = (snapshot: NextTurnQueueSnapshot): string => {
      const current = snapshot.blocker;
      return current
        ? `${current.code}\u0000${current.resumable ? "1" : "0"}\u0000${current.message}`
        : "";
    };

    const publishKnownSnapshot = (snapshot: NextTurnQueueSnapshot) => {
      publishedBlockerKeys.set(snapshot.threadId, blockerKey(snapshot));
      return input.publishSnapshot(snapshot);
    };

    const cleanupItems = (items: ReadonlyArray<{ readonly command: ThreadTurnStartCommand }>) =>
      input.cleanupAttachments(items.flatMap((item) => item.command.message.attachments));

    const getSnapshot = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const stored = yield* input.store.getSnapshot(threadId);
        const first = stored.items[0];
        if (!first) return { ...stored, blocker: null } satisfies NextTurnQueueSnapshot;

        const readModel = yield* input.getReadModel();
        const thread = readModel.threads.find((candidate) => candidate.id === threadId);
        const gate = resolveNextTurnQueueGate(thread, first);
        let queueBlocker = gate.blocker;
        if (gate.kind === "ready" && thread?.worktreePath) {
          const exists = yield* input.worktreeExists(thread.worktreePath);
          if (!exists) {
            queueBlocker = {
              code: "worktree_missing" as const,
              message: `Repair worktree '${thread.worktreePath}' to continue the queue.`,
              resumable: false,
            };
          }
        }
        return { ...stored, blocker: queueBlocker } satisfies NextTurnQueueSnapshot;
      });

    const publish = (threadId: ThreadId) =>
      getSnapshot(threadId).pipe(
        Effect.flatMap(publishKnownSnapshot),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to publish next-turn queue snapshot", {
            threadId,
            causePretty: Cause.pretty(cause),
          }),
        ),
      );

    const drain = drainNextTurnQueue({
      store: input.store,
      getSnapshot: input.getReadModel,
      worktreeExists: input.worktreeExists,
      dispatch: input.dispatch,
      getReceipt: input.receipts.get,
      retryTurnStart: input.retryTurnStart,
      onUpdated: publish,
      onPurged: cleanupItems,
    });

    const runScheduler = Effect.forever(
      Queue.take(wakeQueue).pipe(
        Effect.race(Effect.sleep(Duration.seconds(30))),
        Effect.andThen(drain),
        Effect.catchCause((cause) =>
          Effect.logWarning("next-turn queue drain failed", {
            causePretty: Cause.pretty(cause),
          }),
        ),
      ),
    );

    const start = runScheduler.pipe(Effect.forkIn(input.scope), Effect.andThen(wake));

    const enqueue = (enqueueInput: {
      readonly itemId: CommandId;
      readonly command: ThreadTurnStartCommand;
      readonly createdAttachmentPaths?: ReadonlyArray<string>;
    }) =>
      Effect.gen(function* () {
        yield* input.store
          .enqueue({ itemId: enqueueInput.itemId, command: enqueueInput.command })
          .pipe(
            Effect.tapError(() =>
              input.cleanupAttachmentPaths(enqueueInput.createdAttachmentPaths ?? []),
            ),
          );
        const snapshot = yield* getSnapshot(enqueueInput.command.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return snapshot;
      });

    const pauseQueue = (pauseInput: {
      readonly threadId: ThreadId;
      readonly expectedVersion: number;
    }) =>
      Effect.gen(function* () {
        yield* input.store.pauseQueue(pauseInput);
        const snapshot = yield* getSnapshot(pauseInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        return snapshot;
      });

    const resumeQueue = (resumeInput: {
      readonly threadId: ThreadId;
      readonly expectedVersion: number;
    }) =>
      Effect.gen(function* () {
        yield* input.store.resumeQueue(resumeInput);
        const snapshot = yield* getSnapshot(resumeInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return snapshot;
      });

    const clear = (clearInput: NextTurnQueueClearInput) =>
      Effect.gen(function* () {
        const cleared = yield* input.store.clear(clearInput);
        yield* cleanupItems(cleared.removedItems);
        const snapshot = yield* getSnapshot(clearInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return { snapshot, skippedDispatching: cleared.skippedDispatching };
      });

    const update = (updateInput: NextTurnQueueUpdateInput) =>
      Effect.gen(function* () {
        const before = yield* input.store.getSnapshot(updateInput.threadId);
        const previousItem = before.items.find((item) => item.itemId === updateInput.itemId);
        yield* input.store.update(updateInput);
        const after = yield* input.store.getSnapshot(updateInput.threadId);
        const nextItem = after.items.find((item) => item.itemId === updateInput.itemId);
        if (previousItem && nextItem) {
          const retainedIds = new Set(
            nextItem.command.message.attachments.map((attachment) => attachment.id),
          );
          yield* input.cleanupAttachments(
            previousItem.command.message.attachments.filter(
              (attachment) => !retainedIds.has(attachment.id),
            ),
          );
        }
        const snapshot = yield* getSnapshot(updateInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return snapshot;
      });

    const cancel = (cancelInput: NextTurnQueueCancelInput) =>
      Effect.gen(function* () {
        const result = yield* input.store.cancel(cancelInput);
        if (result.cancelledItem) yield* cleanupItems([result.cancelledItem]);
        const snapshot = yield* getSnapshot(cancelInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return { outcome: result.outcome, snapshot };
      });

    const reorder = (reorderInput: NextTurnQueueReorderInput) =>
      Effect.gen(function* () {
        yield* input.store.reorder(reorderInput);
        const snapshot = yield* getSnapshot(reorderInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return snapshot;
      });

    const resume = (resumeInput: NextTurnQueueResumeInput) =>
      Effect.gen(function* () {
        const before = yield* input.store.getSnapshot(resumeInput.threadId);
        const item = before.items.find((candidate) => candidate.itemId === resumeInput.itemId);
        yield* input.store.resume(resumeInput);
        // A user-triggered retry after delivery_unknown is intentionally
        // at-least-once: the provider may have accepted the original handoff
        // before the process stopped. Never take this path automatically.
        if (item) yield* input.receipts.resetForExplicitRetry(item.command.commandId);
        const snapshot = yield* getSnapshot(resumeInput.threadId);
        yield* publishKnownSnapshot(snapshot);
        yield* wake;
        return snapshot;
      });

    const pauseThread = (threadId: ThreadId, message: string) =>
      Effect.gen(function* () {
        yield* input.store.pauseThread(threadId, {
          code: "manual_pause",
          message,
          resumable: true,
        });
        yield* publish(threadId);
      });

    const purgeThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const purged = yield* input.store.purgeThread(threadId);
        yield* cleanupItems(purged.removedItems);
        yield* publish(threadId);
        return purged;
      });

    const handleThreadLifecycle = (threadId: ThreadId, deleted: boolean) =>
      Effect.gen(function* () {
        if (deleted) {
          yield* purgeThread(threadId);
          publishedBlockerKeys.delete(threadId);
        } else {
          const current = yield* getSnapshot(threadId);
          if (current.items.length === 0) {
            publishedBlockerKeys.delete(threadId);
            return;
          }
          const currentBlockerKey = blockerKey(current);
          if (publishedBlockerKeys.get(threadId) !== currentBlockerKey) {
            yield* input.store.touchVersion(threadId);
            yield* publish(threadId);
          }
        }
        yield* wake;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to reconcile queue after thread lifecycle event", {
            threadId,
            deleted,
            causePretty: Cause.pretty(cause),
          }),
        ),
      );

    return {
      start,
      wake,
      drain,
      getSnapshot,
      publish,
      enqueue,
      pauseQueue,
      resumeQueue,
      clear,
      update,
      cancel,
      reorder,
      resume,
      pauseThread,
      purgeThread,
      handleThreadLifecycle,
    };
  });
}
