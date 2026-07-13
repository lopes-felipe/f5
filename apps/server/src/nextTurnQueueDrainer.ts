import type {
  CommandId,
  NextTurnQueueBlocker,
  NextTurnQueueItem,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { Cause, Effect, Schema } from "effect";

import type { NextTurnQueueStore, NextTurnQueueStoreError } from "./nextTurnQueue";
import { OrchestrationCommandConflictError } from "./orchestration/Errors.ts";
import type { ProviderTurnIntentReceipt } from "./providerTurnIntentReceipts";

export type NextTurnQueueGate =
  | { readonly kind: "ready"; readonly blocker: null }
  | { readonly kind: "wait" | "blocked"; readonly blocker: NextTurnQueueBlocker };

function blocker(
  code: NextTurnQueueBlocker["code"],
  message: string,
  resumable = false,
): NextTurnQueueBlocker {
  return { code, message, resumable };
}

function activityRequestId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function hasOutstandingResponse(thread: OrchestrationThread): boolean {
  const approvals = new Set<string>();
  const userInputs = new Set<string>();
  const activities = [...thread.activities].toSorted(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt),
  );

  for (const activity of activities) {
    const requestId = activityRequestId(activity.payload);
    if (!requestId) continue;
    if (activity.kind === "approval.requested") approvals.add(requestId);
    if (activity.kind === "approval.resolved") {
      approvals.delete(requestId);
    }
    if (activity.kind === "user-input.requested") userInputs.add(requestId);
    if (activity.kind === "user-input.resolved") userInputs.delete(requestId);
  }

  return approvals.size > 0 || userInputs.size > 0;
}

function hasActionableProposedPlan(thread: OrchestrationThread, item: NextTurnQueueItem): boolean {
  if (thread.latestTurn?.state === "running") return false;
  const latest = [...thread.proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (latest === undefined || latest.implementedAt !== null) return false;
  if (item.command.interactionMode === "plan") return false;
  return !(
    item.command.sourceProposedPlan?.threadId === thread.id &&
    item.command.sourceProposedPlan.planId === latest.id
  );
}

export function resolveNextTurnQueueGate(
  thread: OrchestrationThread | undefined,
  item: NextTurnQueueItem,
): NextTurnQueueGate {
  if (item.status === "paused") {
    return {
      kind: "blocked",
      blocker: item.blocker ?? blocker("queue_paused", "Queue is paused.", true),
    };
  }
  if (item.status === "dispatching") {
    return {
      kind: "wait",
      blocker: blocker("provider_handoff", "Waiting for the provider to acknowledge this turn."),
    };
  }
  if (!thread || thread.deletedAt) {
    return {
      kind: "blocked",
      blocker: blocker("thread_missing", "Thread no longer exists."),
    };
  }
  if (thread.archivedAt) {
    return {
      kind: "blocked",
      blocker: blocker("thread_archived", "Unarchive the thread to continue the queue."),
    };
  }
  if (hasOutstandingResponse(thread)) {
    return {
      kind: "blocked",
      blocker: blocker(
        "response_required",
        "Answer the outstanding provider request before the queue can continue.",
      ),
    };
  }
  if (hasActionableProposedPlan(thread, item)) {
    return {
      kind: "blocked",
      blocker: blocker(
        "response_required",
        "Accept or refine the proposed plan before the queue can continue.",
      ),
    };
  }
  if (thread.latestTurn?.state === "running" || thread.session?.activeTurnId != null) {
    return {
      kind: "wait",
      blocker: blocker("active_turn", "Waiting for the active turn to finish."),
    };
  }
  if (
    item.failurePolicy === "stop" &&
    (thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted")
  ) {
    return {
      kind: "blocked",
      blocker:
        thread.latestTurn.state === "error"
          ? blocker(
              "previous_turn_failed",
              "The previous turn failed. Continue anyway to run the next item.",
              true,
            )
          : blocker(
              "previous_turn_interrupted",
              "The previous turn was interrupted. Continue anyway to run the next item.",
              true,
            ),
    };
  }
  if (thread.session?.status === "starting") {
    return {
      kind: "wait",
      blocker: blocker("session_starting", "Waiting for the provider session to become idle."),
    };
  }
  if (
    item.failurePolicy === "stop" &&
    (thread.session?.status === "error" || thread.session?.lastError)
  ) {
    return {
      kind: "blocked",
      blocker: blocker(
        "provider_error",
        thread.session.lastError ?? "The provider session failed.",
        true,
      ),
    };
  }
  return { kind: "ready", blocker: null };
}

function isTransientDispatchRace(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return Schema.is(OrchestrationCommandConflictError)(error) && error.code === "thread_busy";
}

function receiptBlocker(receipt: ProviderTurnIntentReceipt): NextTurnQueueBlocker | null {
  if (receipt.status === "failed") {
    return blocker("provider_error", receipt.error ?? "The provider rejected this turn.", true);
  }
  if (receipt.status === "delivery_unknown") {
    return blocker(
      "delivery_unknown",
      receipt.error ?? "Provider delivery could not be confirmed after restart.",
      true,
    );
  }
  return null;
}

export function drainNextTurnQueue<
  SnapshotError,
  DispatchError,
  ReceiptError,
  RetryError = never,
>(input: {
  readonly store: NextTurnQueueStore;
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, SnapshotError>;
  readonly worktreeExists: (path: string) => Effect.Effect<boolean, never>;
  readonly dispatch: (command: ThreadTurnStartCommand) => Effect.Effect<unknown, DispatchError>;
  readonly getReceipt: (
    commandId: CommandId,
  ) => Effect.Effect<ProviderTurnIntentReceipt | null, ReceiptError>;
  readonly retryTurnStart?:
    | ((commandId: CommandId) => Effect.Effect<boolean, RetryError>)
    | undefined;
  readonly onUpdated: (threadId: ThreadId) => Effect.Effect<void, never>;
  readonly onPurged?:
    | ((items: ReadonlyArray<NextTurnQueueItem>) => Effect.Effect<void, never>)
    | undefined;
  readonly now?: (() => string) | undefined;
}): Effect.Effect<void, NextTurnQueueStoreError | SnapshotError | ReceiptError | RetryError> {
  return Effect.gen(function* () {
    const threadIds = yield* input.store.listThreadIds;
    if (threadIds.length === 0) return;
    const snapshot = yield* input.getSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));

    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const stored = yield* input.store.getSnapshot(threadId);
          const item = stored.items[0];
          if (!item) return;
          const thread = threadsById.get(threadId);

          if (!thread || thread.deletedAt) {
            const purged = yield* input.store.purgeThread(threadId);
            if (input.onPurged) yield* input.onPurged(purged.removedItems);
            yield* input.onUpdated(threadId);
            return;
          }

          if (item.status === "dispatching") {
            const receipt = yield* input.getReceipt(item.command.commandId);
            if (receipt?.status === "accepted") {
              yield* input.store.complete(item.itemId);
              yield* input.onUpdated(threadId);
              return;
            }
            if (receipt) {
              const deliveryBlocker = receiptBlocker(receipt);
              if (deliveryBlocker) {
                yield* input.store.pause(item.itemId, deliveryBlocker);
                yield* input.onUpdated(threadId);
              }
              return;
            }

            // An explicit retry removes a failed provider receipt but retains
            // the original orchestration event. Replay that event first. If no
            // event exists, the crash happened before orchestration accepted
            // the command, so dispatching the same command ID is safe.
            if (input.retryTurnStart) {
              const replayed = yield* input.retryTurnStart(item.command.commandId);
              if (replayed) return;
            }
            const dispatchExit = yield* Effect.exit(
              input.dispatch({
                ...item.command,
                createdAt: item.dispatchStartedAt ?? item.command.createdAt,
              }),
            );
            if (dispatchExit._tag === "Failure") {
              const message = Cause.pretty(dispatchExit.cause);
              if (isTransientDispatchRace(dispatchExit.cause)) {
                yield* input.store.releaseClaim(item.itemId);
              } else {
                yield* input.store.pause(item.itemId, blocker("provider_error", message, true));
              }
              yield* input.onUpdated(threadId);
            }
            return;
          }

          const gate = resolveNextTurnQueueGate(thread, item);
          if (gate.kind !== "ready") return;

          if (thread.worktreePath) {
            const exists = yield* input.worktreeExists(thread.worktreePath);
            if (!exists) return;
          }

          const claimed = yield* input.store.claimHead(
            threadId,
            input.now?.() ?? new Date().toISOString(),
          );
          if (!claimed) return;
          yield* input.onUpdated(threadId);

          const dispatchExit = yield* Effect.exit(input.dispatch(claimed.command));
          if (dispatchExit._tag === "Failure") {
            const message = Cause.pretty(dispatchExit.cause);
            if (isTransientDispatchRace(dispatchExit.cause)) {
              yield* input.store.releaseClaim(claimed.itemId);
            } else {
              yield* input.store.pause(claimed.itemId, blocker("provider_error", message, true));
            }
            yield* input.onUpdated(threadId);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("next-turn queue thread drain failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });
}
