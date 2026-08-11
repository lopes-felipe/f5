import {
  CommandId,
  MAX_QUEUED_TURNS_PER_THREAD,
  ThreadId,
  type NextTurnQueueBlockedKind,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
  type OrchestrationEvent,
  type QueueReasonCode,
  type TurnSubmissionResult,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";

import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../../orchestration/Services/RuntimeReceiptBus.ts";
import { ProviderTurnDeliveryRepository } from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import { NextTurnQueueStorageError, type NextTurnQueueError } from "../Errors.ts";
import {
  NextTurnQueueDispatcher,
  type NextTurnQueueDispatcherShape,
} from "../Services/NextTurnQueueDispatcher.ts";
import { NextTurnQueueStore } from "../Services/NextTurnQueueStore.ts";
import { DISPATCH_LEASE_TTL_MS, QUEUE_WORKER_SHARDS } from "../constants.ts";
import {
  classifyNextTurnDispatchFailure,
  type NextTurnDispatchOutcome,
} from "../dispatchOutcome.ts";
import { resolveNextTurnQueueGate } from "../gate.ts";

interface ThreadWorkState {
  readonly running: boolean;
  readonly dirty: boolean;
}

function shardFor(threadId: ThreadId): number {
  let hash = 2166136261;
  for (const char of threadId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % QUEUE_WORKER_SHARDS;
}

function blockedKindFor(reasonCode: QueueReasonCode, paused: boolean): NextTurnQueueBlockedKind {
  if (!paused) return "waiting";
  return reasonCode === "turn_failed" ||
    reasonCode === "turn_never_started" ||
    reasonCode === "post_processing_stalled" ||
    reasonCode === "delivery_rejected" ||
    reasonCode === "delivery_ambiguous" ||
    reasonCode === "dispatch_rejected"
    ? "error"
    : "paused";
}

function storageError(cause: unknown): NextTurnQueueStorageError {
  return new NextTurnQueueStorageError({
    message: "Could not read the queued turns.",
    cause,
  });
}

export const makeNextTurnQueueDispatcher = Effect.gen(function* () {
  const store = yield* NextTurnQueueStore;
  const threads = yield* ProjectionThreadRepository;
  const sessions = yield* ProjectionThreadSessionRepository;
  const turns = yield* ProjectionTurnRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const engine = yield* OrchestrationEngineService;
  const receiptBus = yield* RuntimeReceiptBus;
  const deliveries = yield* ProviderTurnDeliveryRepository;
  const fileSystem = yield* FileSystem.FileSystem;

  const changesPubSub = yield* PubSub.unbounded<ThreadId>();
  const summaryChangesPubSub = yield* PubSub.unbounded<void>();
  const delayedRetries = yield* PubSub.unbounded<readonly [ThreadId, number]>();
  const threadWork = yield* Ref.make(new Map<ThreadId, ThreadWorkState>());
  const activeDispatches = yield* Ref.make(new Set<CommandId>());
  const automaticCompacting = yield* Ref.make(new Map<ThreadId, number>());
  const waiters = yield* Ref.make(
    new Map<CommandId, Deferred.Deferred<TurnSubmissionResult, NextTurnQueueError>>(),
  );
  const lastPublishedSnapshots = yield* Ref.make(new Map<ThreadId, string>());

  const publishChanged = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* PubSub.publish(changesPubSub, threadId);
      yield* PubSub.publish(summaryChangesPubSub, undefined);
    });

  const settleWaiter = (itemId: CommandId, result: TurnSubmissionResult) =>
    Ref.modify(waiters, (current) => {
      const waiter = current.get(itemId) ?? null;
      if (waiter === null) return [null, current] as const;
      const next = new Map(current);
      next.delete(itemId);
      return [waiter, next] as const;
    }).pipe(
      Effect.flatMap((waiter) =>
        waiter === null ? Effect.void : Deferred.succeed(waiter, result).pipe(Effect.orDie),
      ),
    );

  const readGate = (item: NextTurnQueueItem) =>
    Effect.gen(function* () {
      const queue = yield* store.listByThread(item.threadId);
      const [threadOption, sessionOption, pendingOption, runningOption, terminalOption] =
        yield* Effect.all(
          [
            threads.getById({ threadId: item.threadId }),
            sessions.getByThreadId({ threadId: item.threadId }),
            turns.getPendingTurnStartByThreadId({ threadId: item.threadId }),
            turns.getLatestRunningByThreadId({ threadId: item.threadId }),
            turns.getLatestTerminalByThreadId({ threadId: item.threadId }),
          ],
          { concurrency: 4 },
        ).pipe(Effect.mapError(storageError));
      const thread = Option.getOrNull(threadOption);
      const worktreeExists =
        thread?.worktreePath == null
          ? null
          : yield* fileSystem.stat(thread.worktreePath).pipe(
              Effect.map((entry) => entry.type === "Directory"),
              Effect.catch(() => Effect.succeed(false)),
            );
      const compacting = yield* Ref.get(automaticCompacting);
      return resolveNextTurnQueueGate({
        item,
        state: queue.state,
        thread,
        session: Option.getOrNull(sessionOption),
        pendingTurnStart: Option.getOrNull(pendingOption),
        runningTurn: Option.getOrNull(runningOption),
        terminalTurn: Option.getOrNull(terminalOption),
        hasDispatchingItem: queue.items.some((candidate) => candidate.status === "dispatching"),
        automaticCompaction: compacting.has(item.threadId),
        worktreeExists,
      });
    });

  const getSnapshot = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const data = yield* store.listByThread(threadId);
      const firstRunnable = data.items.find((item) => item.status !== "failed") ?? null;
      let reasonCode = data.state.pauseReasonCode;
      let reasonDetail = data.state.pauseDetail;
      let blockedKind: NextTurnQueueBlockedKind | null = data.state.paused
        ? blockedKindFor(reasonCode ?? "manual_pause", true)
        : null;

      if (firstRunnable !== null && !data.state.paused) {
        const gate = yield* readGate(firstRunnable);
        if (gate.kind !== "ready" && gate.kind !== "drop") {
          reasonCode = gate.reasonCode;
          reasonDetail = gate.detail ?? null;
          blockedKind = blockedKindFor(gate.reasonCode, gate.kind === "autoPause");
        }
      } else if (
        firstRunnable === null &&
        data.items.some((item) => item.status === "failed") &&
        !data.state.paused
      ) {
        const failed = data.items.find((item) => item.status === "failed") ?? null;
        reasonCode = "dispatch_rejected";
        reasonDetail = failed?.lastErrorDetail ?? null;
        blockedKind = "error";
      }

      return {
        threadId,
        items: [...data.items],
        revision: data.state.revision,
        paused: data.state.paused,
        blockedKind,
        reasonCode,
        reasonDetail,
        maxItems: MAX_QUEUED_TURNS_PER_THREAD,
        quarantinedCount: data.quarantinedCount,
      } satisfies NextTurnQueueSnapshot;
    });

  const publishSnapshotIfChanged = (threadId: ThreadId) =>
    getSnapshot(threadId).pipe(
      Effect.flatMap((snapshot) =>
        Ref.modify(lastPublishedSnapshots, (current) => {
          const encoded = JSON.stringify(snapshot);
          if (current.get(threadId) === encoded) return [false, current] as const;
          const next = new Map(current);
          next.set(threadId, encoded);
          return [true, next] as const;
        }).pipe(Effect.flatMap((changed) => (changed ? publishChanged(threadId) : Effect.void))),
      ),
    );

  const finishDispatch = (itemId: CommandId) =>
    Ref.update(activeDispatches, (current) => {
      const next = new Set(current);
      next.delete(itemId);
      return next;
    });

  const scheduleRetry = (threadId: ThreadId, delayMs: number) =>
    PubSub.publish(delayedRetries, [threadId, delayMs] as const).pipe(Effect.asVoid);

  const applyDispatchFailure = (
    item: NextTurnQueueItem,
    leaseOwner: string,
    outcome: NextTurnDispatchOutcome,
  ) =>
    outcome.kind === "failed"
      ? store.markFailed({
          itemId: item.itemId,
          leaseOwner,
          errorCode: outcome.errorCode,
          errorDetail: outcome.errorDetail,
        })
      : Effect.gen(function* () {
          const notBefore = new Date(Date.now() + outcome.delayMs).toISOString();
          yield* store.releaseLease({
            itemId: item.itemId,
            leaseOwner,
            notBefore,
            errorCode: outcome.errorCode,
            errorDetail: outcome.errorDetail,
            clearDispatchStartedAt: outcome.clearDispatchStartedAt,
            consumeAttempt: outcome.consumeAttempt,
          });
          yield* scheduleRetry(item.threadId, outcome.delayMs);
        });

  const processThread = (threadId: ThreadId): Effect.Effect<void, NextTurnQueueError> =>
    Effect.gen(function* () {
      const queue = yield* store.listByThread(threadId);
      const deliveryFailure = queue.items.find(
        (candidate) =>
          candidate.status === "failed" &&
          (candidate.lastErrorCode === "delivery_rejected" ||
            candidate.lastErrorCode === "delivery_ambiguous"),
      );
      if (deliveryFailure) {
        const deliveryReason =
          deliveryFailure.lastErrorCode === "delivery_ambiguous"
            ? "delivery_ambiguous"
            : "delivery_rejected";
        yield* store.setPaused({
          threadId,
          paused: true,
          reasonCode: deliveryReason,
          detail: deliveryFailure.lastErrorDetail,
        });
        yield* publishSnapshotIfChanged(threadId);
        return;
      }
      const item = queue.items.find((candidate) => candidate.status !== "failed") ?? null;
      if (item === null) {
        yield* publishSnapshotIfChanged(threadId);
        return;
      }
      const gate = yield* readGate(item);
      if (gate.kind === "drop") {
        yield* store.deleteForThread(threadId);
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "rejected",
          submissionId: item.submissionId,
          reasonCode: gate.reasonCode,
        });
        return;
      }
      if (gate.kind === "autoPause") {
        yield* store.setPaused({
          threadId,
          paused: true,
          reasonCode: gate.reasonCode,
          detail: gate.detail ?? null,
        });
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "queued",
          submissionId: item.submissionId,
          itemId: item.itemId,
          snapshot: yield* getSnapshot(threadId),
        });
        return;
      }
      if (gate.kind === "wait") {
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "queued",
          submissionId: item.submissionId,
          itemId: item.itemId,
          snapshot: yield* getSnapshot(threadId),
        });
        return;
      }

      if (item.attemptCount > 0) {
        const receipt = yield* receipts
          .getByCommandId({ commandId: item.command.commandId })
          .pipe(Effect.mapError(storageError));
        if (Option.isSome(receipt) && receipt.value.status === "accepted") {
          const delivery = yield* deliveries
            .getByCommandId(item.command.commandId)
            .pipe(Effect.mapError(storageError));
          if (delivery?.state === "accepted") {
            yield* store.completeDelivery({ commandId: item.command.commandId });
          } else if (delivery?.state === "rejected" || delivery?.state === "ambiguous") {
            yield* store.markDeliveryFailed({
              commandId: item.command.commandId,
              errorCode:
                delivery.state === "ambiguous" ? "delivery_ambiguous" : "delivery_rejected",
              errorDetail: delivery.errorDetail ?? "The provider did not confirm this turn.",
            });
          } else {
            yield* store.retryDelivery({ commandId: item.command.commandId });
          }
          yield* publishSnapshotIfChanged(threadId);
          yield* settleWaiter(item.itemId, {
            disposition: "started",
            submissionId: item.submissionId,
            sequence: receipt.value.resultSequence,
          });
          return;
        }
      }

      const leaseOwner = `next-turn-queue:${process.pid}:${crypto.randomUUID()}`;
      const claimed = yield* store.claim({
        itemId: item.itemId,
        leaseOwner,
        now: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + DISPATCH_LEASE_TTL_MS).toISOString(),
      });
      if (claimed === null) return;
      yield* Ref.update(activeDispatches, (current) => new Set(current).add(item.itemId));

      const latestState = yield* store.listByThread(threadId);
      if (latestState.state.paused) {
        yield* store.releaseLease({
          itemId: item.itemId,
          leaseOwner,
          notBefore: new Date().toISOString(),
          errorCode: "manual_pause",
          errorDetail: "Queue paused before dispatch.",
          clearDispatchStartedAt: true,
          consumeAttempt: false,
        });
        yield* finishDispatch(item.itemId);
        return;
      }

      const command = {
        ...claimed.item.command,
        dispatchSource: "next-turn-queue" as const,
        createdAt: claimed.item.dispatchStartedAt ?? claimed.item.command.createdAt,
      };
      const exit = yield* Effect.exit(engine.dispatch(command));
      yield* finishDispatch(item.itemId);
      if (exit._tag === "Success") {
        yield* store.markAwaitingDelivery({
          itemId: item.itemId,
          leaseOwner,
          sequence: exit.value.sequence,
        });
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "started",
          submissionId: item.submissionId,
          sequence: exit.value.sequence,
        });
        return;
      }

      const error = Cause.squash(exit.cause);
      const outcome = classifyNextTurnDispatchFailure({
        error,
        postClaimAttempt: claimed.item.attemptCount,
      });
      yield* applyDispatchFailure(claimed.item, leaseOwner, outcome);
      yield* publishSnapshotIfChanged(threadId);
      yield* settleWaiter(item.itemId, {
        disposition: "queued",
        submissionId: item.submissionId,
        itemId: item.itemId,
        snapshot: yield* getSnapshot(threadId),
      });
    });

  let workers: ReadonlyArray<DrainableWorker<ThreadId>> = [];

  const enqueueDirect = (threadId: ThreadId) => workers[shardFor(threadId)]!.enqueue(threadId);

  const finishThread = (threadId: ThreadId) =>
    Ref.modify(threadWork, (current) => {
      const state = current.get(threadId);
      if (state?.dirty) {
        const next = new Map(current);
        next.set(threadId, { running: true, dirty: false });
        return [true, next] as const;
      }
      const next = new Map(current);
      next.delete(threadId);
      return [false, next] as const;
    }).pipe(Effect.flatMap((again) => (again ? enqueueDirect(threadId) : Effect.void)));

  workers = yield* Effect.forEach(
    Array.from({ length: QUEUE_WORKER_SHARDS }),
    () =>
      makeDrainableWorker((threadId: ThreadId) =>
        processThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("next-turn queue worker failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
          Effect.ensuring(finishThread(threadId)),
        ),
      ),
    { concurrency: 1 },
  );

  const notify = (threadId: ThreadId) =>
    Ref.modify(threadWork, (current) => {
      const state = current.get(threadId);
      if (state) {
        const next = new Map(current);
        next.set(threadId, { running: true, dirty: true });
        return [false, next] as const;
      }
      const next = new Map(current);
      next.set(threadId, { running: true, dirty: false });
      return [true, next] as const;
    }).pipe(Effect.flatMap((enqueue) => (enqueue ? enqueueDirect(threadId) : Effect.void)));

  const pauseForEvent = (threadId: ThreadId, reasonCode: QueueReasonCode, detail: string) =>
    store
      .setPaused({ threadId, paused: true, reasonCode, detail })
      .pipe(Effect.andThen(notify(threadId)));

  const reactToDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const threadId = event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
      if (threadId === null) return;
      switch (event.type) {
        case "thread.deleted":
          yield* store.deleteForThread(threadId);
          yield* publishChanged(threadId);
          return;
        case "thread.archived":
          yield* pauseForEvent(
            threadId,
            "thread_archived",
            "Queue paused because the thread was archived.",
          );
          return;
        case "thread.checkpoint-revert-requested":
          yield* pauseForEvent(
            threadId,
            "thread_reverted",
            "Queue paused because the thread was reverted.",
          );
          return;
        case "thread.compact-requested":
          if (event.payload.trigger === "automatic") {
            yield* Ref.update(automaticCompacting, (current) => {
              const next = new Map(current);
              next.set(threadId, Date.now());
              return next;
            });
            yield* notify(threadId);
          } else {
            yield* pauseForEvent(
              threadId,
              "thread_compacted",
              "Queue paused because the thread was compacted.",
            );
          }
          return;
        case "thread.compacted":
          yield* Ref.update(automaticCompacting, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
          yield* notify(threadId);
          return;
        case "thread.turn-interrupt-requested": {
          const data = yield* store.listByThread(threadId);
          if (
            event.commandId !== null &&
            data.state.interruptSuppressionCommandId === event.commandId
          ) {
            yield* store.setInterruptSuppression({ threadId, commandId: null });
            yield* notify(threadId);
          } else {
            yield* pauseForEvent(
              threadId,
              "turn_interrupted",
              "Queue paused because the active turn was interrupted.",
            );
          }
          return;
        }
        case "thread.session-set":
        case "thread.unarchived":
        case "thread.reverted":
          yield* notify(threadId);
          return;
        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("next-turn queue event reaction failed", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const safetySweep = Effect.gen(function* () {
    yield* Ref.update(automaticCompacting, (current) => {
      const next = new Map(current);
      const cutoff = Date.now() - 5 * 60_000;
      for (const [threadId, startedAt] of next) {
        if (startedAt <= cutoff) next.delete(threadId);
      }
      return next;
    });
    const live = yield* Ref.get(activeDispatches);
    const reclaimed = yield* store.reclaimStaleLeases(live);
    const expired = yield* store.hardDeleteExpired;
    yield* store.purgeSettledSubmissions;
    const actionable = yield* store.listActionableThreadIds;
    yield* Effect.forEach(new Set([...reclaimed, ...expired, ...actionable]), notify, {
      concurrency: 4,
      discard: true,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("next-turn queue safety sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const dispatcher: NextTurnQueueDispatcherShape = {
    notify,
    drain: Effect.forEach(workers, (worker) => worker.drain, {
      concurrency: QUEUE_WORKER_SHARDS,
      discard: true,
    }),
    getSnapshot: (threadId) => getSnapshot(threadId),
    getSummary: store.summary,
    submitAndSettle: (input) =>
      Effect.gen(function* () {
        const waiter = yield* Deferred.make<TurnSubmissionResult, NextTurnQueueError>();
        yield* Ref.update(waiters, (current) => new Map(current).set(input.itemId, waiter));
        yield* notify(input.threadId);
        return yield* Deferred.await(waiter).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            onTimeout: () =>
              getSnapshot(input.threadId).pipe(
                Effect.map(
                  (snapshot): TurnSubmissionResult => ({
                    disposition: "queued",
                    submissionId: input.submissionId,
                    itemId: input.itemId,
                    snapshot,
                  }),
                ),
              ),
          }),
          Effect.ensuring(
            Ref.update(waiters, (current) => {
              const next = new Map(current);
              next.delete(input.itemId);
              return next;
            }),
          ),
        );
      }),
    promote: (input) =>
      Effect.gen(function* () {
        let item = yield* store.getItem(input.itemId);
        if (item === null) {
          return yield* new NextTurnQueueStorageError({
            message: "That queued turn no longer exists.",
          });
        }
        let data = yield* store.listByThread(item.threadId);
        if (item.status === "failed") {
          if (
            item.lastErrorCode === "delivery_rejected" ||
            item.lastErrorCode === "delivery_ambiguous"
          ) {
            return yield* new NextTurnQueueStorageError({
              message:
                "Resolve this provider delivery with Recheck, Retry, or Discard before running it.",
            });
          }
          item = yield* store.retry({ itemId: item.itemId, expectedUpdatedAt: item.updatedAt });
          data = yield* store.listByThread(item.threadId);
        } else if (data.state.revision !== input.expectedRevision) {
          return yield* new NextTurnQueueStorageError({
            message: "The queue changed in another client. Refresh and try again.",
          });
        }
        const orderedItemIds = [
          item.itemId,
          ...data.items
            .filter((candidate) => candidate.itemId !== item!.itemId)
            .map((candidate) => candidate.itemId),
        ];
        yield* store.replacePositions({
          threadId: item.threadId,
          orderedItemIds,
          expectedRevision: data.state.revision,
        });
        const interruptCommandId = input.interruptActive
          ? CommandId.makeUnsafe(crypto.randomUUID())
          : null;
        if (interruptCommandId !== null) {
          yield* store.setInterruptSuppression({
            threadId: item.threadId,
            commandId: interruptCommandId,
          });
        }
        yield* store.setPaused({ threadId: item.threadId, paused: false });
        if (interruptCommandId !== null) {
          const interruptExit = yield* Effect.exit(
            engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: interruptCommandId,
              threadId: item.threadId,
              createdAt: new Date().toISOString(),
            }),
          );
          if (interruptExit._tag === "Failure") {
            yield* store.setInterruptSuppression({ threadId: item.threadId, commandId: null });
          }
        }
        yield* notify(item.threadId);
        yield* publishChanged(item.threadId);
        return yield* getSnapshot(item.threadId);
      }),
    refreshGate: (threadId) =>
      Effect.gen(function* () {
        yield* notify(threadId);
        return yield* getSnapshot(threadId);
      }),
    handleDeliveryOutcome: (outcome) =>
      (outcome.state === "accepted"
        ? store
            .completeDelivery({ commandId: outcome.commandId })
            .pipe(
              Effect.andThen(publishChanged(outcome.threadId)),
              Effect.andThen(notify(outcome.threadId)),
            )
        : store
            .markDeliveryFailed({
              commandId: outcome.commandId,
              errorCode: outcome.state === "ambiguous" ? "delivery_ambiguous" : "delivery_rejected",
              errorDetail: outcome.detail ?? "The provider did not confirm the queued turn.",
            })
            .pipe(
              Effect.andThen(
                store.setPaused({
                  threadId: outcome.threadId,
                  paused: true,
                  reasonCode:
                    outcome.state === "ambiguous" ? "delivery_ambiguous" : "delivery_rejected",
                  detail: outcome.detail ?? "The provider did not confirm the queued turn.",
                }),
              ),
              Effect.andThen(publishChanged(outcome.threadId)),
              Effect.andThen(notify(outcome.threadId)),
            )
      ).pipe(Effect.mapError(storageError)),
    changes: Stream.fromPubSub(changesPubSub),
    summaryChanges: Stream.fromPubSub(summaryChangesPubSub),
    start: Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const live = yield* Ref.get(activeDispatches);
        yield* store.reclaimStaleLeases(live);
        yield* store.deleteOrphans;
        yield* store.drainOrphanedAttachments;
        const actionable = yield* store.listActionableThreadIds;
        yield* Effect.forEach(actionable, notify, { concurrency: 4, discard: true });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("next-turn queue startup reconciliation failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* Stream.runForEach(engine.streamDomainEvents, reactToDomainEvent).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(receiptBus.stream, (receipt) => notify(receipt.threadId)).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(Stream.fromPubSub(delayedRetries), ([threadId, delayMs]) =>
        Effect.sleep(Duration.millis(delayMs)).pipe(
          Effect.andThen(notify(threadId)),
          Effect.forkScoped,
          Effect.asVoid,
        ),
      ).pipe(Effect.forkScoped);
      yield* Effect.forever(safetySweep.pipe(Effect.andThen(Effect.sleep("5 seconds")))).pipe(
        Effect.forkScoped,
      );
    }),
  };

  return dispatcher;
});

export const NextTurnQueueDispatcherLive = Layer.effect(
  NextTurnQueueDispatcher,
  makeNextTurnQueueDispatcher,
);
