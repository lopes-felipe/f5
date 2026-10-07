import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { executionProviderFingerprintFor } from "../../provider/providerConfigurationFingerprint.ts";
import { UsageService } from "../../usage/Services/UsageService.ts";
import { resolveAccountUsageLimit } from "../../provider/usageLimitMessages.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  scheduleUsageLimitResumeFor,
  usageLimitKey,
  LEDGER_RETENTION_MS,
  BUFFER_MS,
  MAX_HORIZON_MS,
  SCAN_EVERY_SWEEPS,
  normalizeTarget,
} from "../usageLimitResume.ts";
import { recoverRestartTurnMarkers } from "../restartTurns.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ProviderInstanceId as importProviderInstanceId,
  EventId as importEventIdFactory,
} from "@t3tools/contracts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { withWorktreeLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import { WorktreeSetupGate } from "../../project/Services/WorktreeSetupGate.ts";
import {
  CommandId,
  MAX_QUEUED_TURNS_PER_THREAD,
  ThreadId,
  type NextTurnQueueBlockedKind,
  type NextTurnQueueItem,
  type NextTurnQueueSnapshot,
  type OrchestrationEvent,
  type OrchestrationThread,
  type QueueReasonCode,
  type ServerSettings,
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
  Semaphore,
} from "effect";

import { reconcileAcceptedPendingTurnStartsBestEffort } from "../../orchestration/acceptedPendingTurnReconciliation.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../../orchestration/Services/RuntimeReceiptBus.ts";
import { ProviderTurnDeliveryRepository } from "../../orchestration/Services/ProviderTurnDeliveryRepository.ts";
import {
  NextTurnQueueStorageError,
  NextTurnQueueConflictError,
  NextTurnQueueUsageLimitStateError,
  type NextTurnQueueError,
} from "../Errors.ts";
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
  const scope = yield* Effect.scope;
  const secretsOption = yield* Effect.serviceOption(ServerSecretStore);
  const protectedFingerprint = (config: import("@t3tools/contracts").ProviderInstanceConfig) => {
    const fingerprint = executionProviderFingerprintFor(config);
    return (
      Option.isSome(secretsOption)
        ? fingerprint.pipe(Effect.provideService(ServerSecretStore, secretsOption.value))
        : fingerprint
    ).pipe(Effect.mapError(storageError));
  };
  const readinessRetries = new Map<ThreadId, { commandId: CommandId; count: number }>();
  const usageOption = yield* Effect.serviceOption(UsageService);
  const registryOption = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const restartSettingsOption = yield* Effect.serviceOption(ServerSettingsService);
  const threads = yield* ProjectionThreadRepository;
  const sessions = yield* ProjectionThreadSessionRepository;
  const turns = yield* ProjectionTurnRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const engine = yield* OrchestrationEngineService;
  const receiptBus = yield* RuntimeReceiptBus;
  const deliveries = yield* ProviderTurnDeliveryRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitCore;
  const worktreeSetupGate = yield* Effect.serviceOption(WorktreeSetupGate);
  const readWorktreeSetupGate = (threadId: ThreadId, token: string | null) =>
    Option.isSome(worktreeSetupGate)
      ? worktreeSetupGate.value.check(threadId, token)
      : Effect.succeed(token === null ? ("none" as const) : ("orphaned" as const));

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

  const readGate = (item: NextTurnQueueItem, recreate = false) =>
    Effect.gen(function* () {
      const pendingBeforeRepair = yield* turns
        .getPendingTurnStartByThreadId({ threadId: item.threadId })
        .pipe(Effect.mapError(storageError));
      if (Option.isSome(pendingBeforeRepair)) {
        yield* reconcileAcceptedPendingTurnStartsBestEffort(turns, item.threadId);
      }
      // Read lifecycle barriers after repair: a newly projected turn may have
      // supplied the message association that allowed cleanup to succeed.
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
      const dispatching = queue.items.filter((candidate) => candidate.status === "dispatching");
      const expectedTurnId = item.command.expectedTurnId;
      // ACP prompt delivery remains "sending" for the whole active turn.
      // Permit steering alongside that start, but retain the barrier for other
      // steers, unclaimed starts, mismatched turns and ambiguous deliveries.
      const canSteerAlongsideStart =
        expectedTurnId !== undefined &&
        Option.getOrNull(sessionOption)?.activeTurnId === expectedTurnId &&
        (yield* Effect.forEach(dispatching, (candidate) =>
          deliveries.getByCommandId(candidate.command.commandId).pipe(
            Effect.map(
              (delivery) =>
                delivery?.state === "sending" &&
                delivery.event.type === "thread.turn-start-requested",
            ),
            Effect.mapError(storageError),
          ),
        )).every(Boolean);
      const resumeContext =
        item.scheduleReason === "usage_limit_reset"
          ? yield* store.getUsageResumeContext(item.itemId)
          : null;
      const settings =
        resumeContext && Option.isSome(restartSettingsOption)
          ? yield* restartSettingsOption.value.getSettings.pipe(Effect.mapError(storageError))
          : null;
      const config = resumeContext
        ? settings?.providerInstances[
            importProviderInstanceId.makeUnsafe(resumeContext.providerInstanceId)
          ]
        : null;
      const fingerprintChanged =
        !!resumeContext?.fingerprint &&
        !!settings &&
        (!config || (yield* protectedFingerprint(config)) !== resumeContext.fingerprint);
      const gate = resolveNextTurnQueueGate({
        scheduleLimitKey: resumeContext?.limitKey,
        scheduleState: resumeContext?.state,
        scheduleProviderInstanceId: resumeContext?.providerInstanceId,
        providerContextChanged:
          fingerprintChanged ||
          (resumeContext && Option.isSome(registryOption)
            ? !(yield* registryOption.value.getInstance(
                importProviderInstanceId.makeUnsafe(resumeContext.providerInstanceId),
              ))
            : false),
        item,
        state: queue.state,
        thread,
        session: Option.getOrNull(sessionOption),
        pendingTurnStart: Option.getOrNull(pendingOption),
        runningTurn: Option.getOrNull(runningOption),
        terminalTurn: Option.getOrNull(terminalOption),
        hasDispatchingItem: dispatching.length > 0 && !canSteerAlongsideStart,
        automaticCompaction: compacting.has(item.threadId),
        worktreeExists: thread?.branch ? null : worktreeExists,
        worktreeSetup: yield* readWorktreeSetupGate(item.threadId, queue.state.worktreeBlockToken),
      });
      if (gate.kind !== "ready" || worktreeExists !== false || !thread?.worktreePath) return gate;
      const model = yield* engine.getReadModel();
      const project = model.projects.find((entry) => entry.id === thread.projectId);
      if (!project || !thread.branch)
        return { kind: "autoPause" as const, reasonCode: "worktree_missing" as const };
      return yield* Effect.gen(function* () {
        if (!(yield* git.branchExists(project.workspaceRoot, thread.branch!))) {
          return {
            kind: "autoPause" as const,
            reasonCode: "worktree_missing" as const,
            detail: `Worktree branch ${thread.branch} is missing.`,
          };
        }
        if (recreate)
          yield* git.ensureWorktree({
            cwd: project.workspaceRoot,
            path: thread.worktreePath!,
            branch: thread.branch!,
          });
        return gate;
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            kind: "autoPause" as const,
            reasonCode: "worktree_missing" as const,
            detail: error.message,
          }),
        ),
      );
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

      const session = ((yield* engine.getReadModel()).threads ?? []).find(
        (entry) => entry.id === threadId,
      )?.session;
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
        usageLimitResume: yield* store
          .getUsageResumeLedger(threadId)
          .pipe(
            Effect.map((ledger) =>
              ledger ? { ...ledger, resetsAt: session?.usageLimit?.resetsAt ?? null } : null,
            ),
          ),
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
      let deliveryFailure = queue.items.find(
        (candidate) =>
          candidate.status === "failed" &&
          (candidate.lastErrorCode === "delivery_rejected" ||
            candidate.lastErrorCode === "delivery_ambiguous"),
      );
      if (deliveryFailure?.lastErrorCode === "delivery_rejected") {
        const delivery = yield* deliveries
          .getByCommandId(deliveryFailure.command.commandId)
          .pipe(Effect.mapError(storageError));
        const limitKey = usageLimitKey({ usageLimit: delivery?.usageLimit });
        const recovery = queue.items.find(
          (candidate) =>
            candidate.scheduleReason === "usage_limit_reset" && candidate.status === "queued",
        );
        const context = recovery ? yield* store.getUsageResumeContext(recovery.itemId) : null;
        if (delivery?.certainty === "not_sent" && limitKey && context?.limitKey === limitKey)
          deliveryFailure = undefined;
      }
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
      // A running worktree setup holds its path lock; check its gate first so
      // this worker shard never blocks behind a long checkout or script.
      if ((yield* readWorktreeSetupGate(threadId, queue.state.worktreeBlockToken)) === "gating") {
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "queued",
          submissionId: item.submissionId,
          itemId: item.itemId,
          snapshot: yield* getSnapshot(threadId),
        });
        return;
      }
      // Gate check through acceptance runs under the lifecycle lock of the
      // directory the turn works in, so cleanup, setup cancellation,
      // recreation and default-branch auto-pull cannot interleave with a start.
      // A thread without a worktree works in its project root.
      const thread = Option.getOrNull(
        yield* threads.getById({ threadId }).pipe(Effect.mapError(storageError)),
      );
      const lockPath =
        thread?.worktreePath ??
        (thread
          ? ((yield* engine.getReadModel()).projects.find(
              (project) => project.id === thread.projectId,
            )?.workspaceRoot ?? null)
          : null);
      const start = startFromGate(item);
      yield* lockPath
        ? withWorktreeLifecycleLock(lockPath, start).pipe(
            Effect.catchTag("RepositoryLifecycleError", (error) =>
              Effect.fail(storageError(error)),
            ),
          )
        : start;
    });

  const startFromGate = (item: NextTurnQueueItem): Effect.Effect<void, NextTurnQueueError> =>
    Effect.gen(function* () {
      const threadId = item.threadId;
      const expectedRevision = (yield* store.listByThread(threadId)).state.revision;
      const gate = yield* readGate(item, true);
      if (gate.kind === "drop") {
        if (item.scheduleReason === "usage_limit_reset" && gate.reasonCode !== "thread_deleted") {
          yield* store.softDelete({ itemId: item.itemId });
          yield* notify(threadId);
        } else yield* store.deleteForThread(threadId);
        yield* publishSnapshotIfChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "rejected",
          submissionId: item.submissionId,
          reasonCode: gate.reasonCode,
        });
        return;
      }
      if (gate.kind === "autoPause") {
        yield* store
          .setPaused({
            threadId,
            paused: true,
            reasonCode: gate.reasonCode,
            detail: gate.detail ?? null,
            expectedRevision,
          })
          .pipe(Effect.catchTag("NextTurnQueueConflictError", () => notify(threadId)));
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
        const savedDelivery = yield* deliveries
          .getByCommandId(item.command.commandId)
          .pipe(Effect.mapError(storageError));
        const steerFallback =
          savedDelivery?.state === "rejected" &&
          savedDelivery.certainty === "not_sent" &&
          savedDelivery.event.type === "thread.turn-steer-requested" &&
          item.lastErrorCode === "steer_queued";
        if (Option.isSome(receipt) && receipt.value.status === "accepted" && !steerFallback) {
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
            disposition:
              delivery?.event.type === "thread.turn-steer-requested" &&
              delivery.state === "accepted"
                ? "steered"
                : "started",
            submissionId: item.submissionId,
            sequence: receipt.value.resultSequence,
          });
          return;
        }
      }

      if (item.scheduleReason === "usage_limit_reset" && Option.isSome(restartSettingsOption)) {
        const context = yield* store.getUsageResumeContext(item.itemId);
        if (context?.source === "auto") {
          const thread = ((yield* engine.getReadModel()).threads ?? []).find(
            (entry) => entry.id === threadId,
          );
          const settings = yield* restartSettingsOption.value.getSettings.pipe(
            Effect.mapError(storageError),
          );
          if (
            !thread ||
            !(
              settings.projectSettingsOverrides[thread.projectId]?.autoResumeUsageLimitedThreads ??
              settings.autoResumeUsageLimitedThreads
            )
          ) {
            yield* store.revokeAutoResumes([threadId]);
            yield* publishChanged(threadId);
            return;
          }
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
        ...(claimed.item.command.expectedTurnId
          ? {
              type: "thread.turn.steer" as const,
              expectedTurnId: claimed.item.command.expectedTurnId,
            }
          : {}),
        dispatchSource: "next-turn-queue" as const,
        createdAt: claimed.item.dispatchStartedAt ?? claimed.item.command.createdAt,
      };
      const exit = yield* Effect.exit(
        engine.dispatch(
          claimed.item.command.expectedTurnId
            ? {
                ...command,
                type: "thread.turn.steer",
                expectedTurnId: claimed.item.command.expectedTurnId,
              }
            : { ...command, type: "thread.turn.start" },
        ),
      );
      yield* finishDispatch(item.itemId);
      if (exit._tag === "Success") {
        readinessRetries.delete(threadId);
        yield* store.markAwaitingDelivery({
          itemId: item.itemId,
          leaseOwner,
          sequence: exit.value.sequence,
        });
        yield* publishSnapshotIfChanged(threadId);
        if (!claimed.item.command.expectedTurnId)
          yield* settleWaiter(item.itemId, {
            disposition: claimed.item.command.expectedTurnId ? "steered" : "started",
            submissionId: item.submissionId,
            sequence: exit.value.sequence,
          });
        return;
      }

      const error = Cause.squash(exit.cause);
      if (
        claimed.item.command.expectedTurnId &&
        error &&
        typeof error === "object" &&
        "_tag" in error &&
        error._tag === "OrchestrationCommandInvariantError"
      ) {
        yield* store.fallbackSteer(claimed.item.command.commandId);
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`steer-queued:${claimed.item.command.commandId}`),
            threadId,
            activity: {
              id: importEventIdFactory.makeUnsafe(`steer-queued:${claimed.item.command.commandId}`),
              kind: "turn.steer.queued",
              tone: "info",
              summary: "Steer not accepted; queued",
              payload: { messageId: claimed.item.command.message.messageId },
              turnId: null,
              createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          })
          .pipe(Effect.mapError(storageError));
        yield* notify(threadId);
        yield* publishChanged(threadId);
        yield* settleWaiter(item.itemId, {
          disposition: "queued",
          submissionId: item.submissionId,
          itemId: item.itemId,
          snapshot: yield* getSnapshot(threadId),
        });
        return;
      }
      const notReady =
        !!error &&
        typeof error === "object" &&
        "_tag" in error &&
        error._tag === "ThreadTurnNotReadyError";
      const previousRetry = readinessRetries.get(threadId);
      const readinessAttempt = notReady
        ? (previousRetry?.commandId === claimed.item.command.commandId ? previousRetry.count : 0) +
          1
        : 0;
      if (notReady)
        readinessRetries.set(threadId, {
          commandId: claimed.item.command.commandId,
          count: readinessAttempt,
        });
      else readinessRetries.delete(threadId);
      const outcome = classifyNextTurnDispatchFailure({
        error,
        postClaimAttempt: claimed.item.attemptCount,
        readinessAttempt,
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

  const cancelUnsentResume = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const queue = yield* store.listByThread(threadId);
      for (const item of queue.items)
        if (item.scheduleReason === "usage_limit_reset" && item.status === "queued")
          yield* store.softDelete({ itemId: item.itemId }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("could not cancel unsent usage resume", {
                    threadId,
                    itemId: item.itemId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
    });
  const reactToDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const threadId = event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
      if (threadId === null) return;
      switch (event.type) {
        case "thread.session-stop-requested":
          yield* cancelUnsentResume(threadId);
          yield* notify(threadId);
          return;
        case "thread.deleted":
          yield* store.deleteForThread(threadId);
          yield* publishChanged(threadId);
          return;
        case "thread.archived":
          yield* cancelUnsentResume(threadId);
          yield* pauseForEvent(
            threadId,
            "thread_archived",
            "Queue paused because the thread was archived.",
          );
          return;
        case "thread.conversation-revert-requested":
          yield* cancelUnsentResume(threadId);
          // The engine pauses with `rewind_in_progress` in the same transaction as the
          // request; the rewind itself then records success or failure. Pausing here as
          // `thread_reverted` would claim a revert happened before it did.
          yield* notify(threadId);
          return;
        case "thread.checkpoint-revert-requested":
          yield* cancelUnsentResume(threadId);
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
            yield* cancelUnsentResume(threadId);
            yield* pauseForEvent(
              threadId,
              "turn_interrupted",
              "Queue paused because the active turn was interrupted.",
            );
          }
          return;
        }
        case "thread.session-set": {
          const current = ((yield* engine.getReadModel()).threads ?? []).find(
            (entry) => entry.id === threadId,
          )?.session;
          if (
            event.payload.settledTurnId &&
            current?.status === "ready" &&
            current.lastError === null
          ) {
            yield* store.resetUsageResumeStreak(threadId);
            yield* store.completeUsageResume(threadId);
          }
          if (
            current?.usageLimit &&
            !current.activeTurnId &&
            current.status !== "running" &&
            current.status !== "starting"
          )
            yield* scanUsageLimitResumes(false, threadId);
          yield* notify(threadId);
          return;
        }
        case "thread.user-input-resolved":
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

  const scheduleResume = (input: {
    threadId: ThreadId;
    source: "manual" | "auto";
    notBefore?: string | undefined;
    expectedLimitKey?: string | undefined;
    thread?: OrchestrationThread | undefined;
  }) =>
    scheduleUsageLimitResumeFor(input).pipe(
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(NextTurnQueueStore, store),
      (effect) =>
        Option.isSome(secretsOption)
          ? effect.pipe(Effect.provideService(ServerSecretStore, secretsOption.value))
          : effect,
      (effect) =>
        Option.isSome(restartSettingsOption)
          ? effect.pipe(Effect.provideService(ServerSettingsService, restartSettingsOption.value))
          : effect,
    );
  const scanSemaphore = yield* Semaphore.make(1);
  const previousPolicy = new Map<ThreadId, boolean>();
  const refreshAttempts = new Map<
    ThreadId,
    { key: string; inFlight: boolean; attempts: number; nextAllowedAt: number }
  >();
  const refreshLimit = (threadId: ThreadId, expectedKey: string) =>
    Effect.gen(function* () {
      const thread = ((yield* engine.getReadModel()).threads ?? []).find(
        (entry) => entry.id === threadId,
      );
      const session = thread?.session;
      if (
        !session?.usageLimit ||
        usageLimitKey(session) !== expectedKey ||
        Option.isNone(usageOption)
      )
        return { resolved: false };
      const detectedAt = new Date().toISOString();
      const result = yield* usageOption.value
        .refreshAccount(session.usageLimit.providerInstanceId)
        .pipe(Effect.mapError(storageError));
      if (!result.fresh || !result.snapshot)
        return { resolved: false, nextAllowedAt: result.nextAllowedAt };
      const limit = resolveAccountUsageLimit(session.usageLimit, result.snapshot, detectedAt);
      if (!limit.resetsAt) return { resolved: false };
      const latest = ((yield* engine.getReadModel()).threads ?? []).find(
        (entry) => entry.id === threadId,
      )?.session;
      if (!latest || usageLimitKey(latest) !== expectedKey) return { resolved: true };
      yield* engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          session: { ...latest, usageLimit: { ...session.usageLimit, ...limit } },
          createdAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(storageError));
      const target = Math.max(Date.now(), Date.parse(limit.resetsAt)) + BUFFER_MS;
      const notBefore = normalizeTarget(target);
      if (notBefore && target <= Date.now() + MAX_HORIZON_MS) {
        const queue = yield* store.listByThread(threadId);
        yield* store.rescheduleByInstance(session.usageLimit.providerInstanceId, notBefore, {
          limitKey: expectedKey,
          revision: queue.state.revision,
        });
        yield* notify(threadId);
      }
      return { resolved: true };
    });
  const scanUsageLimitResumes = (
    policyChange = false,
    failureThreadId?: ThreadId,
    emittedSettings?: ServerSettings,
  ) =>
    scanSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (Option.isNone(restartSettingsOption)) return;
        const settings = emittedSettings ?? (yield* restartSettingsOption.value.getSettings);
        const model = yield* engine.getReadModel();
        if (!failureThreadId) {
          const liveThreads = new Map(
            model.threads
              .filter((thread) => !thread.deletedAt)
              .map((thread) => [thread.id, thread]),
          );
          for (const id of previousPolicy.keys())
            if (!liveThreads.has(id)) previousPolicy.delete(id);
          for (const id of readinessRetries.keys())
            if (!liveThreads.has(id)) readinessRetries.delete(id);
          for (const [id, attempt] of refreshAttempts) {
            const current = liveThreads.get(id)?.session;
            if (
              !liveThreads.has(id) ||
              usageLimitKey(current) !== attempt.key ||
              current?.usageLimit?.resetsAt
            )
              refreshAttempts.delete(id);
          }
        }
        const candidates = failureThreadId
          ? model.threads.filter((thread) => thread.id === failureThreadId)
          : model.threads;
        const policies = candidates.map((thread) => ({
          thread,
          enabled:
            settings.projectSettingsOverrides[thread.projectId]?.autoResumeUsageLimitedThreads ??
            settings.autoResumeUsageLimitedThreads,
          wasEnabled: previousPolicy.get(thread.id),
        }));
        // Only policy transitions need revocation. SQL filters the entire disabled scope once.
        const disabled = policies
          .filter(({ enabled, wasEnabled }) => !enabled && wasEnabled !== false)
          .map(({ thread }) => thread.id);
        for (const id of yield* store.revokeAutoResumes(disabled)) {
          yield* publishChanged(id);
          yield* notify(id);
        }
        for (const { thread, enabled, wasEnabled } of policies) {
          // Failure events and sweeps may see a new setting before its subscription callback.
          // They must not consume the transition that grants eligibility to existing blocks.
          if (!failureThreadId && (policyChange || wasEnabled === undefined))
            previousPolicy.set(thread.id, enabled);
          const session = thread.session;
          if (
            !session?.usageLimit ||
            session.activeTurnId ||
            session.status === "starting" ||
            session.status === "running"
          )
            continue;
          const key = usageLimitKey(session);
          if (!key) continue;
          const future =
            !!session.usageLimit.resetsAt && Date.parse(session.usageLimit.resetsAt) > Date.now();
          // The failure event records the effective policy even when its reset is unknown.
          // Sweeps must not create a row that preempts that decision.
          if (failureThreadId === thread.id || (enabled && future))
            yield* store.recordUsageResumeFailure(thread.id, key, enabled);
          if (policyChange && enabled && wasEnabled !== true) {
            if (!future) continue;
            yield* store.markUsageResumeEligible(thread.id, key);
          }
          if (!enabled) continue;
          if (!failureThreadId && !future && session.usageLimit.resetsAt) {
            const ledger = yield* store.getUsageResumeLedger(thread.id);
            if (!ledger || ledger.limitKey !== key) continue;
          }
          if (!session.usageLimit.resetsAt && !failureThreadId) {
            const previous = refreshAttempts.get(thread.id);
            if (
              !previous ||
              previous.key !== key ||
              (!previous.inFlight && previous.nextAllowedAt <= Date.now())
            ) {
              const attempt = {
                key,
                inFlight: true,
                attempts: (previous?.key === key ? previous.attempts : 0) + 1,
                nextAllowedAt: 0,
              };
              refreshAttempts.set(thread.id, attempt);
              yield* refreshLimit(thread.id, key).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("usage-limit refresh failed", {
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as({ resolved: false })),
                ),
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (refreshAttempts.get(thread.id) !== attempt) return;
                    if (result.resolved) refreshAttempts.delete(thread.id);
                    else {
                      attempt.inFlight = false;
                      const providerDeadline =
                        "nextAllowedAt" in result && typeof result.nextAllowedAt === "string"
                          ? Date.parse(result.nextAllowedAt)
                          : 0;
                      attempt.nextAllowedAt = Math.max(
                        Number.isFinite(providerDeadline) ? providerDeadline : 0,
                        Date.now() +
                          Math.min(300_000, 5_000 * 2 ** Math.min(6, attempt.attempts - 1)),
                      );
                    }
                  }),
                ),
                Effect.forkIn(scope),
              );
            }
          }
          const result = yield* scheduleResume({ threadId: thread.id, source: "auto", thread });
          if (result.kind === "created" || result.kind === "rebound") {
            yield* publishChanged(thread.id);
            yield* notify(thread.id);
          }
        }
      }),
    );
  const recoverRestartTurns = Effect.gen(function* () {
    if (Option.isNone(sqlOption)) return;
    const recovery = Option.isSome(restartSettingsOption)
      ? recoverRestartTurnMarkers.pipe(
          Effect.provideService(ServerSettingsService, restartSettingsOption.value),
        )
      : recoverRestartTurnMarkers;
    const resumed = yield* recovery.pipe(
      Effect.provideService(SqlClient.SqlClient, sqlOption.value),
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(NextTurnQueueStore, store),
      Effect.mapError(storageError),
    );
    for (const threadId of resumed) yield* notify(threadId);
  });

  let safetySweepCount = 0;
  const safetySweep = Effect.gen(function* () {
    const maintenanceDue = safetySweepCount++ % SCAN_EVERY_SWEEPS === 0;
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
    yield* recoverRestartTurns.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("restart recovery sweep failed", { cause: Cause.pretty(cause) }),
      ),
    );
    if (maintenanceDue)
      yield* Effect.gen(function* () {
        yield* scanUsageLimitResumes();
        yield* store.pruneUsageResumeLedger(
          new Date(Date.now() - LEDGER_RETENTION_MS).toISOString(),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage-limit maintenance failed", { cause: Cause.pretty(cause) }),
        ),
      );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("next-turn queue safety sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const dispatcher: NextTurnQueueDispatcherShape = {
    notify,
    scheduleUsageLimitResume: (input) =>
      Effect.gen(function* () {
        const thread = (yield* engine.getReadModel()).threads.find(
          (entry) => entry.id === input.threadId,
        );
        if (input.expectedLimitKey && usageLimitKey(thread?.session) !== input.expectedLimitKey)
          return yield* new NextTurnQueueConflictError({
            message: "The usage limit changed. Refresh and try again.",
          });
        const result = yield* scheduleResume({
          ...input,
          source: input.source ?? "manual",
          thread,
        });
        if (result.kind === "ineligible" || result.kind === "transient")
          return yield* new NextTurnQueueUsageLimitStateError({
            message: result.reason,
            reason: result.kind,
          });
        if (result.kind === "already_scheduled" && input.notBefore) {
          const context = (yield* store.listByThread(input.threadId)).items.find(
            (item) => item.scheduleReason === "usage_limit_reset",
          );
          const metadata = context ? yield* store.getUsageResumeContext(context.itemId) : null;
          if (metadata) {
            const queue = yield* store.listByThread(input.threadId);
            const target = normalizeTarget(Date.parse(input.notBefore));
            if (target)
              yield* store.rescheduleByInstance(metadata.providerInstanceId, target, {
                limitKey: metadata.limitKey,
                revision: queue.state.revision,
              });
          }
        }
        yield* publishChanged(input.threadId);
        yield* notify(input.threadId);
        return yield* getSnapshot(input.threadId);
      }),
    cancelUsageLimitResume: (input) =>
      Effect.gen(function* () {
        const data = yield* store.listByThread(input.threadId);
        if (data.state.revision !== input.expectedRevision)
          return yield* new NextTurnQueueConflictError({
            message: "The queue changed. Refresh and try again.",
          });
        const item = data.items.find(
          (item) => item.itemId === input.itemId && item.scheduleReason === "usage_limit_reset",
        );
        if (item?.status === "dispatching")
          return { kind: "already_sending" as const, snapshot: yield* getSnapshot(input.threadId) };
        if (item)
          yield* store.softDelete({
            itemId: item.itemId,
            expectedUpdatedAt: item.updatedAt,
            expectedRevision: input.expectedRevision,
          });
        yield* publishChanged(input.threadId);
        yield* notify(input.threadId);
        return { kind: "cancelled" as const, snapshot: yield* getSnapshot(input.threadId) };
      }).pipe(
        Effect.catchTag("NextTurnQueueItemDispatchingError", () =>
          getSnapshot(input.threadId).pipe(
            Effect.map((snapshot) => ({ kind: "already_sending" as const, snapshot })),
          ),
        ),
      ),
    refreshUsageLimitResume: (input) =>
      Effect.gen(function* () {
        const current = ((yield* engine.getReadModel()).threads ?? []).find(
          (entry) => entry.id === input.threadId,
        )?.session;
        if (usageLimitKey(current) !== input.expectedLimitKey)
          return yield* new NextTurnQueueConflictError({
            message: "The usage limit changed. Refresh and try again.",
          });
        yield* refreshLimit(input.threadId, input.expectedLimitKey);
        yield* publishChanged(input.threadId);
        return yield* getSnapshot(input.threadId);
      }),
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
          ...(item.scheduleReason === "usage_limit_reset"
            ? { clearScheduleItemId: item.itemId }
            : {}),
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
      Effect.gen(function* () {
        const item = yield* store.getByCommandId(outcome.commandId);
        if (outcome.state === "rejected" && item?.command.expectedTurnId) {
          yield* store.fallbackSteer(outcome.commandId);
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe(`steer-queued:${outcome.commandId}`),
              threadId: item.threadId,
              activity: {
                id: importEventIdFactory.makeUnsafe(`steer-queued:${outcome.commandId}`),
                kind: "turn.steer.queued",
                tone: "info",
                summary: "Steer not accepted; queued",
                payload: { messageId: item.command.message.messageId },
                turnId: null,
                createdAt: new Date().toISOString(),
              },
              createdAt: new Date().toISOString(),
            })
            .pipe(Effect.mapError(storageError));
          yield* settleWaiter(item.itemId, {
            disposition: "queued",
            submissionId: item.submissionId,
            itemId: item.itemId,
            snapshot: yield* getSnapshot(item.threadId),
          });
          yield* publishChanged(outcome.threadId);
          yield* notify(outcome.threadId);
          return;
        }
        if (outcome.state === "accepted" && item?.command.expectedTurnId) {
          const receipt = yield* receipts
            .getByCommandId({ commandId: outcome.commandId })
            .pipe(Effect.mapError(storageError));
          yield* settleWaiter(item.itemId, {
            disposition: "steered",
            submissionId: item.submissionId,
            sequence: Option.isSome(receipt) ? receipt.value.resultSequence : 0,
          });
        }
        yield* outcome.state === "accepted"
          ? store
              .completeDelivery({ commandId: outcome.commandId })
              .pipe(
                Effect.andThen(publishChanged(outcome.threadId)),
                Effect.andThen(notify(outcome.threadId)),
              )
          : store
              .markDeliveryFailed({
                commandId: outcome.commandId,
                errorCode:
                  outcome.state === "ambiguous" ? "delivery_ambiguous" : "delivery_rejected",
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
              );
      }).pipe(Effect.mapError(storageError)),
    changes: Stream.fromPubSub(changesPubSub),
    summaryChanges: Stream.fromPubSub(summaryChangesPubSub),
    start: Effect.gen(function* () {
      if (Option.isSome(restartSettingsOption))
        yield* Stream.runForEach(yield* restartSettingsOption.value.subscribeChanges, (settings) =>
          scanUsageLimitResumes(true, undefined, settings).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("usage resume settings scan failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        const live = yield* Ref.get(activeDispatches);
        yield* store.reclaimStaleLeases(live);
        yield* store.deleteOrphans;
        yield* store.drainOrphanedAttachments;
        yield* recoverRestartTurns;
        yield* scanUsageLimitResumes();
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
