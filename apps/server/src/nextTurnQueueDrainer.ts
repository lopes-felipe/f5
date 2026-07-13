import type {
  NextTurnQueueItem,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Cause, Effect } from "effect";

import type { NextTurnQueueStore, NextTurnQueueStoreError } from "./nextTurnQueue";

export type NextTurnQueueGate =
  | { readonly kind: "ready"; readonly reason: null }
  | { readonly kind: "wait" | "pause"; readonly reason: string };

export function resolveNextTurnQueueGate(
  thread: OrchestrationThread | undefined,
  item: NextTurnQueueItem,
): NextTurnQueueGate {
  if (item.status === "paused") {
    return { kind: "pause", reason: item.lastError ?? "Queue is paused." };
  }
  if (!thread || thread.deletedAt) {
    return { kind: "pause", reason: "Thread no longer exists." };
  }
  if (thread.archivedAt) {
    return { kind: "pause", reason: "Thread is archived." };
  }
  if (thread.latestTurn?.state === "running") {
    return { kind: "wait", reason: "Waiting for the active turn to finish." };
  }
  if (
    !item.allowAfterError &&
    (thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted")
  ) {
    return {
      kind: "pause",
      reason:
        thread.latestTurn.state === "error"
          ? "Queue paused after the previous turn failed."
          : "Queue paused after the previous turn was interrupted.",
    };
  }
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return { kind: "wait", reason: "Waiting for the provider session to become idle." };
  }
  if (!item.allowAfterError && (thread.session?.status === "error" || thread.session?.lastError)) {
    return {
      kind: "pause",
      reason: thread.session.lastError ?? "Queue paused after a provider error.",
    };
  }
  return { kind: "ready", reason: null };
}

function isTransientDispatchRace(message: string): boolean {
  return /(?:active|already|running|in progress).{0,40}turn|turn.{0,40}(?:active|running|in progress)/iu.test(
    message,
  );
}

export function drainNextTurnQueue<SnapshotError, DispatchError>(input: {
  readonly store: NextTurnQueueStore;
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, SnapshotError>;
  readonly worktreeExists: (path: string) => Effect.Effect<boolean, never>;
  readonly dispatch: (command: ThreadTurnStartCommand) => Effect.Effect<unknown, DispatchError>;
  readonly onUpdated: (threadId: ThreadId) => Effect.Effect<void, never>;
  readonly now?: (() => string) | undefined;
}): Effect.Effect<void, NextTurnQueueStoreError | SnapshotError> {
  return Effect.gen(function* () {
    const threadIds = yield* input.store.listThreadIds;
    if (threadIds.length === 0) return;
    const snapshot = yield* input.getSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));

    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const items = yield* input.store.list(threadId);
          const item = items[0];
          if (!item) return;
          const thread = threadsById.get(threadId);
          const gate = resolveNextTurnQueueGate(thread, item);
          if (gate.kind === "wait") return;
          if (gate.kind === "pause") {
            if (item.status !== "paused" || item.lastError !== gate.reason) {
              yield* input.store.pause(item.itemId, gate.reason);
              yield* input.onUpdated(threadId);
            }
            return;
          }

          if (thread?.worktreePath) {
            const exists = yield* input.worktreeExists(thread.worktreePath);
            if (!exists) {
              yield* input.store.pause(
                item.itemId,
                `Queue paused because worktree '${thread.worktreePath}' is missing.`,
              );
              yield* input.onUpdated(threadId);
              return;
            }
          }

          const command = yield* input.store.prepareForDispatch(
            item.itemId,
            input.now?.() ?? new Date().toISOString(),
          );
          const dispatchExit = yield* Effect.exit(input.dispatch(command));
          if (dispatchExit._tag === "Failure") {
            const message = Cause.pretty(dispatchExit.cause);
            if (!isTransientDispatchRace(message)) {
              yield* input.store.pause(item.itemId, message);
              yield* input.onUpdated(threadId);
            }
            return;
          }

          yield* input.store.complete(item.itemId);
          yield* input.onUpdated(threadId);
        }),
      { concurrency: 1, discard: true },
    );
  });
}
