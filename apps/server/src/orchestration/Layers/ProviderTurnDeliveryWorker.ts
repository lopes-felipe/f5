import { assertScheduledDeliveryAllowed } from "../../scheduledTasks/deliveryGate.ts";
import { fenceScheduledRun } from "../../scheduledTasks/cancellation.ts";
import { scheduledSendGate } from "../../scheduledTasks/sendGate.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { registerShutdown } from "../../shutdown.ts";
import { DeliveryAttemptContext } from "../../provider/deliveryAttemptContext";
import { CommandId, TurnId, type OrchestrationUsageLimit, type ThreadId } from "@t3tools/contracts";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Metric,
  Option,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import {
  deliveryAmbiguousTotal,
  deliveryAttemptsActive,
  deliveryOutboxRowsDecoded,
  metricAttributes,
} from "../../observability/Metrics.ts";

import { reconcileAcceptedPendingTurnStartsBestEffort } from "../acceptedPendingTurnReconciliation.ts";
import { ProviderTurnDeliveryError, ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  ProviderTurnDeliveryRepository,
  type ProviderTurnDelivery,
} from "../Services/ProviderTurnDeliveryRepository.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryOutcome,
  type ProviderTurnDeliveryWorkerShape,
} from "../Services/ProviderTurnDeliveryWorker.ts";

const make = Effect.gen(function* () {
  const repository = yield* ProviderTurnDeliveryRepository;
  const scheduledSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const scheduledSettings = yield* Effect.serviceOption(ServerSettingsService);
  const provider = yield* ProviderService;
  const reactor = yield* ProviderCommandReactor;
  const turns = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngineService;
  const sourceScope = yield* Scope.make("sequential");
  let stopping = false;
  const stopSources = Effect.gen(function* () {
    stopping = true;
    yield* Scope.close(sourceScope, Exit.void);
  });
  yield* Effect.addFinalizer(() => stopSources);
  yield* registerShutdown("provider-delivery-sources", "admission", () => stopSources);
  const shutdownBeforeSend = () =>
    new ProviderTurnDeliveryError({
      certainty: "not_sent",
      retryable: true,
      detail: "Server shutdown stopped this turn before dispatch.",
    });
  const scheduledHandoff = (commandId: string) =>
    Option.isSome(scheduledSql) && Option.isSome(scheduledSettings)
      ? assertScheduledDeliveryAllowed(commandId).pipe(
          Effect.provideService(SqlClient.SqlClient, scheduledSql.value),
          Effect.provideService(ServerSettingsService, scheduledSettings.value),
        )
      : Effect.void;
  const preparationSlots = yield* Semaphore.make(8);
  const controlPreparationSlots = yield* Semaphore.make(2);
  const delayed = yield* PubSub.unbounded<readonly [CommandId, number]>();
  const outcomes = yield* PubSub.unbounded<ProviderTurnDeliveryOutcome>();

  const markAccepted = (input: {
    readonly deliveryId: CommandId;
    readonly commandId: CommandId;
    readonly threadId: ProviderTurnDeliveryOutcome["threadId"];
    readonly providerTurnId: TurnId;
    readonly receipt?: typeof import("../Services/ProviderTurnDeliveryRepository").DeliveryAcceptanceReceipt.Type;
    readonly attemptId?: string | null | undefined;
  }) =>
    repository.markAccepted(input).pipe(
      Effect.flatMap((changed) =>
        changed
          ? reconcileAcceptedPendingTurnStartsBestEffort(turns, input.threadId).pipe(
              Effect.andThen(
                PubSub.publish(outcomes, {
                  deliveryId: input.deliveryId,
                  commandId: input.commandId,
                  threadId: input.threadId,
                  state: "accepted",
                  detail: null,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const markRejected = (input: {
    readonly deliveryId: CommandId;
    readonly commandId: CommandId;
    readonly threadId: ProviderTurnDeliveryOutcome["threadId"];
    readonly attemptId?: string | null | undefined;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
    readonly usageLimit?: OrchestrationUsageLimit | undefined;
  }) =>
    Effect.gen(function* () {
      const occurredAt = new Date().toISOString();
      const changed = yield* repository.markRejected({ ...input, occurredAt });
      if (!changed) return;
      if (input.ambiguous) yield* Metric.update(deliveryAmbiguousTotal, 1);
      yield* PubSub.publish(outcomes, {
        deliveryId: input.deliveryId,
        commandId: input.commandId,
        threadId: input.threadId,
        state: input.ambiguous ? "ambiguous" : "rejected",
        detail: input.errorDetail,
        occurredAt,
        ...(input.usageLimit ? { usageLimit: input.usageLimit } : {}),
      });
    });

  // History alone does not correlate a dispatch: even one new turn may be
  // another client's turn or a steer. Only a durable acceptance receipt proves
  // acceptance. Legacy and incomplete baselines therefore remain ambiguous.
  const findProvenProviderTurn = (delivery: ProviderTurnDelivery) =>
    Effect.succeed(
      delivery.acceptanceReceipt?.attemptId === delivery.attemptId
        ? (delivery.acceptanceReceipt?.turnId ?? null)
        : null,
    );

  const settleClaimedDelivery = (
    deliveryId: CommandId,
    initialClaimed: ProviderTurnDelivery,
    handoff: Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      let claimed = initialClaimed;
      if (
        claimed.event.type !== "thread.turn-start-requested" &&
        claimed.event.type !== "thread.turn-steer-requested"
      ) {
        yield* markRejected({
          deliveryId,
          attemptId: claimed.attemptId,
          commandId: claimed.commandId,
          threadId: claimed.threadId,
          errorCode: "invalid_event",
          errorDetail: "The durable delivery did not contain a turn-start event.",
          certainty: "not_sent",
          ambiguous: false,
        });
        return;
      }

      const turnEvent = claimed.event;
      const exit = yield* Effect.exit(
        Effect.suspend(() =>
          stopping ? Effect.fail(shutdownBeforeSend()) : reactor.deliverTurnStart(turnEvent),
        ).pipe(
          Effect.provideService(
            DeliveryAttemptContext,
            claimed.attemptId
              ? {
                  attemptId: claimed.attemptId,
                  accepted: (receipt, identity) =>
                    Effect.gen(function* () {
                      const intent = yield* repository.getByCommandId(claimed.commandId);
                      if (!intent || intent.attemptId !== claimed.attemptId) return;
                      if (
                        intent.event.type !== "thread.turn-steer-requested" &&
                        intent.preSendTurnIds.includes(receipt.turnId)
                      )
                        return yield* new ProviderTurnDeliveryError({
                          certainty: "unknown",
                          retryable: false,
                          detail:
                            "Provider reported a pre-existing turn instead of accepting a new dispatch.",
                        });
                      yield* markAccepted({
                        deliveryId,
                        commandId: claimed.commandId,
                        threadId: claimed.threadId,
                        providerTurnId: receipt.turnId,
                        attemptId: claimed.attemptId,
                        receipt: {
                          turnId: receipt.turnId,
                          attemptId: claimed.attemptId!,
                          ...identity,
                          acceptedAt: new Date().toISOString(),
                        },
                      });
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderTurnDeliveryError({
                            certainty: "unknown",
                            retryable: false,
                            detail: "Could not persist provider acceptance receipt.",
                            cause,
                          }),
                      ),
                    ),
                  prepared: (snapshot) =>
                    (engine.waitForControlProgress?.(claimed.threadId) ?? Effect.void).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderTurnDeliveryError({
                            certainty: "not_sent",
                            retryable: true,
                            detail: "Control processing stopped before dispatch.",
                            cause,
                          }),
                      ),
                      Effect.andThen(
                        Effect.suspend(() =>
                          stopping
                            ? Effect.fail(shutdownBeforeSend())
                            : engine.isTurnStartSuperseded?.(claimed.event)
                              ? Effect.fail(
                                  new ProviderTurnDeliveryError({
                                    certainty: "not_sent",
                                    retryable: false,
                                    detail: "The session stopped before this turn was sent.",
                                  }),
                                )
                              : repository
                                  .recordDispatchIntent({
                                    deliveryId,
                                    attemptId: claimed.attemptId!,
                                    preSendTurnIds:
                                      snapshot?.turns.map((turn) => turn.id) ??
                                      claimed.preSendTurnIds,
                                    historyEvidence:
                                      snapshot?.history ?? claimed.historyEvidence ?? null,
                                  })
                                  .pipe(
                                    Effect.mapError(
                                      (cause) =>
                                        new ProviderTurnDeliveryError({
                                          certainty: "not_sent",
                                          retryable: true,
                                          detail: "Could not persist provider dispatch intent.",
                                          cause,
                                        }),
                                    ),
                                    Effect.flatMap((recorded) =>
                                      recorded
                                        ? Effect.suspend(() =>
                                            stopping
                                              ? Effect.fail(shutdownBeforeSend())
                                              : scheduledHandoff(claimed.commandId).pipe(
                                                  Effect.andThen(
                                                    Effect.suspend(() =>
                                                      stopping
                                                        ? Effect.fail(shutdownBeforeSend())
                                                        : handoff,
                                                    ),
                                                  ),
                                                ),
                                          )
                                        : Effect.fail(
                                            new ProviderTurnDeliveryError({
                                              certainty: "not_sent",
                                              retryable: false,
                                              detail:
                                                "This delivery attempt no longer owns dispatch.",
                                            }),
                                          ),
                                    ),
                                  ),
                        ),
                      ),
                    ),
                }
              : null,
          ),
        ),
      );
      const settled = yield* repository.getByCommandId(claimed.commandId);
      if (!settled || (claimed.attemptId && settled.attemptId !== claimed.attemptId)) return;
      claimed = settled;
      if (claimed.state === "accepted") return;
      if (
        exit._tag === "Success" &&
        exit.value !== undefined &&
        claimed.event.type !== "thread.turn-steer-requested" &&
        claimed.preSendTurnIds.includes(exit.value.turnId)
      ) {
        // A turn start must create a new provider turn. Reporting a turn that
        // already existed before the send proves nothing about this message.
        yield* Effect.logWarning("provider delivery reported a pre-existing turn", {
          deliveryId,
          threadId: claimed.threadId,
          turnId: exit.value.turnId,
        });
        yield* markRejected({
          deliveryId,
          attemptId: claimed.attemptId,
          commandId: claimed.commandId,
          threadId: claimed.threadId,
          errorCode: "provider_turn_not_new",
          errorDetail:
            "The provider reported an existing turn instead of starting a new one, so this message may not have been delivered. Recheck provider history before retrying.",
          certainty: "unknown",
          ambiguous: true,
        });
        return;
      }
      if (exit._tag === "Success" && exit.value !== undefined) {
        yield* markAccepted({
          deliveryId,
          attemptId: claimed.attemptId,
          commandId: claimed.commandId,
          threadId: claimed.threadId,
          providerTurnId: exit.value.turnId,
        });
        return;
      }

      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
      const typedDeliveryError = Schema.is(ProviderTurnDeliveryError)(error) ? error : null;
      const steering = claimed.event.type === "thread.turn-steer-requested";
      let rejected = false;
      let nested: unknown = error;
      const seen = new Set<unknown>();
      while (nested && typeof nested === "object" && !seen.has(nested)) {
        seen.add(nested);
        if (
          ("code" in nested && typeof nested.code === "number" && nested.code < 0) ||
          ("method" in nested &&
            nested.method === "turn/steer" &&
            !("cause" in nested && nested.cause))
        )
          rejected = true;
        nested = "cause" in nested ? nested.cause : undefined;
      }
      // Only a structured usage rejection at the turn-start call boundary proves
      // the provider refused this send. Transport text alone never does.
      const requestError = Schema.is(ProviderAdapterRequestError)(error) ? error : null;
      const rejectedLimit =
        typedDeliveryError?.usageLimit ??
        (requestError?.method === "turn/start" ? requestError.usageLimit : undefined);
      const notSent =
        Boolean(rejectedLimit) ||
        typedDeliveryError?.certainty === "not_sent" ||
        (steering && rejected);
      if (
        exit._tag === "Failure" &&
        (typedDeliveryError === null || typedDeliveryError.certainty === "unknown")
      ) {
        yield* Effect.logWarning("provider delivery failed with unknown certainty", {
          deliveryId,
          threadId: claimed.threadId,
          cause: Cause.pretty(exit.cause),
        });
      }
      const detail =
        typedDeliveryError?.message ??
        requestError?.message ??
        "The provider delivery outcome is unknown. Recheck provider history before retrying.";
      if (
        !steering &&
        notSent &&
        typedDeliveryError?.retryable === true &&
        !typedDeliveryError.usageLimit &&
        (stopping || claimed.attempt < 3)
      ) {
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, claimed.attempt - 1));
        yield* repository.requeue({
          deliveryId,
          notBefore: new Date(Date.now() + delayMs).toISOString(),
          errorCode:
            error && typeof error === "object" && "_tag" in error ? String(error._tag) : "not_sent",
          errorDetail: detail,
        });
        yield* PubSub.publish(delayed, [deliveryId, delayMs] as const);
        return;
      }
      if (claimed.event.type === "thread.turn-start-requested")
        yield* reactor.recordTurnStartFailure(claimed.event, detail).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to record terminal provider delivery error", {
              deliveryId,
              threadId: claimed.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      const thread = rejectedLimit
        ? (yield* engine.getReadModel()).threads.find((entry) => entry.id === claimed.threadId)
        : undefined;
      const instanceId = thread?.session?.providerInstanceId ?? thread?.modelSelection?.instanceId;
      const usageLimit =
        notSent && rejectedLimit && instanceId
          ? { ...rejectedLimit, providerInstanceId: instanceId, turnId: null, deliveryId }
          : undefined;
      yield* markRejected({
        deliveryId,
        attemptId: claimed.attemptId,
        commandId: claimed.commandId,
        threadId: claimed.threadId,
        errorCode:
          error && typeof error === "object" && "_tag" in error ? String(error._tag) : "unknown",
        errorDetail: detail,
        certainty: notSent ? "not_sent" : "unknown",
        ambiguous: !notSent,
        ...(usageLimit ? { usageLimit } : {}),
      });
    });

  const processDelivery = (deliveryId: CommandId) =>
    Effect.gen(function* () {
      if (stopping) return;
      const candidate = yield* repository.getByCommandId(deliveryId);
      if (
        !candidate ||
        candidate.state !== "pending" ||
        (candidate.notBefore !== null && Date.parse(candidate.notBefore) > Date.now())
      )
        return;
      if (Option.isSome(scheduledSql) && Option.isSome(scheduledSettings)) {
        const gate = yield* scheduledSendGate(
          scheduledSql.value,
          yield* scheduledSettings.value.getSettings,
          candidate.commandId,
        );
        if (gate === "cancel") {
          const sql = scheduledSql.value;
          const links = yield* sql<{
            run_id: string;
          }>`SELECT run_id FROM scheduled_run_submissions WHERE submission_id=${candidate.commandId}`;
          if (links[0])
            yield* sql.withTransaction(
              fenceScheduledRun(
                links[0].run_id,
                new Date(yield* Clock.currentTimeMillis).toISOString(),
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
            );
          return;
        }
        if (gate === "wait") return;
      }
      yield* Metric.update(
        Metric.withAttributes(deliveryOutboxRowsDecoded, metricAttributes({ source: "claim" })),
        1,
      );
      // A later turn must not create/reuse a session while an earlier stop is
      // still in the reactor. Stops also reject pending rows before claim.
      yield* engine.waitForControlProgress?.(candidate.threadId) ?? Effect.void;
      const baseline = yield* provider
        .readThread(candidate.threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (stopping) return;
      const claimed = yield* repository.claim(
        deliveryId,
        baseline?.turns.map((turn) => turn.id) ?? [],
        baseline?.history ?? null,
      );
      if (!claimed) return;
      const slots =
        claimed.event.type === "thread.turn-steer-requested"
          ? controlPreparationSlots
          : preparationSlots;
      let released = false;
      const handoff = Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return slots.release(1).pipe(Effect.asVoid);
      });
      yield* Effect.acquireUseRelease(
        slots.take(1),
        () =>
          Effect.acquireUseRelease(
            Metric.modify(deliveryAttemptsActive, 1),
            () => settleClaimedDelivery(deliveryId, claimed, handoff),
            () => Metric.modify(deliveryAttemptsActive, -1),
          ),
        () => handoff,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("provider turn delivery worker failed", {
              deliveryId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  // The database is the queue. Retain only operations actually handed off,
  // with one ordinary owner per thread; unrelated ACP prompts run independently.
  const operationScope = yield* Effect.scope;
  const active = new Map<string, Fiber.Fiber<void, never> | null>();
  const enqueue = (delivery: {
    deliveryId: CommandId;
    threadId: ThreadId;
    event: { type: string };
  }) =>
    Effect.gen(function* () {
      if (stopping) return;
      const key = `${delivery.event.type === "thread.turn-steer-requested" ? "steer" : "start"}:${delivery.threadId}`;
      const reserved = yield* Effect.sync(() => {
        if (active.has(key)) return false;
        active.set(key, null);
        return true;
      });
      if (!reserved) return;
      // Register before executing, including when the operation finishes synchronously.
      const ready = yield* Deferred.make<void>();
      const operation = yield* Effect.forkIn(
        Deferred.await(ready).pipe(
          Effect.andThen(
            processDelivery(delivery.deliveryId).pipe(
              Effect.provideService(Scope.Scope, operationScope),
            ),
          ),
          Effect.ensuring(Effect.sync(() => active.delete(key))),
        ),
        operationScope,
      );
      active.set(key, operation);
      yield* Deferred.succeed(ready, undefined);
    });
  const enqueueById = (deliveryId: CommandId) =>
    repository
      .getByCommandId(deliveryId)
      .pipe(Effect.flatMap((delivery) => (delivery ? enqueue(delivery) : Effect.void)));
  const drain: Effect.Effect<void> = Effect.suspend(() =>
    active.size === 0
      ? Effect.void
      : Effect.all([...active.values()].filter((fiber) => fiber !== null).map(Fiber.join), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(drain)),
  );

  const reconcileSending: Effect.Effect<
    void,
    import("../Services/ProviderTurnDeliveryRepository").ProviderTurnDeliveryRepositoryError
  > = Effect.gen(function* () {
    const sending = yield* repository.listSending;
    yield* Effect.forEach(
      sending,
      (delivery) =>
        provider.readThread(delivery.threadId).pipe(
          Effect.flatMap(() => findProvenProviderTurn(delivery)),
          Effect.flatMap((newTurnId) => {
            return delivery.event.type !== "thread.turn-steer-requested" && newTurnId !== null
              ? markAccepted({
                  deliveryId: delivery.deliveryId,
                  commandId: delivery.commandId,
                  threadId: delivery.threadId,
                  providerTurnId: newTurnId,
                })
              : markRejected({
                  deliveryId: delivery.deliveryId,
                  commandId: delivery.commandId,
                  threadId: delivery.threadId,
                  errorCode: "startup_reconciliation_ambiguous",
                  errorDetail: "Could not prove whether the provider accepted this turn.",
                  certainty: "unknown",
                  ambiguous: true,
                });
          }),
          Effect.catch(() =>
            markRejected({
              deliveryId: delivery.deliveryId,
              commandId: delivery.commandId,
              threadId: delivery.threadId,
              errorCode: "startup_reconciliation_failed",
              errorDetail: "Could not inspect provider history after restart.",
              certainty: "unknown",
              ambiguous: true,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    if (sending.length === 64) yield* reconcileSending;
  });

  let scanCursor = "";
  const enqueueActionable = Effect.gen(function* () {
    const candidates = yield* repository.listCandidateIds({ afterThreadId: scanCursor, limit: 64 });
    scanCursor = candidates.length === 64 ? candidates.at(-1)!.threadId : "";
    yield* Metric.update(
      Metric.withAttributes(deliveryOutboxRowsDecoded, metricAttributes({ source: "sweep" })),
      candidates.length,
    );
    yield* Effect.forEach(candidates, ({ deliveryId }) => enqueueById(deliveryId), {
      discard: true,
    });
  });

  const replayTerminalOutcomes = repository.listUnprojectedTerminal.pipe(
    Effect.flatMap((deliveries) =>
      Effect.forEach(
        deliveries,
        (delivery) =>
          reconcileAcceptedPendingTurnStartsBestEffort(turns, delivery.threadId).pipe(
            Effect.andThen(
              PubSub.publish(outcomes, {
                deliveryId: delivery.deliveryId,
                commandId: delivery.commandId,
                threadId: delivery.threadId,
                state: delivery.state as "accepted" | "rejected" | "ambiguous",
                detail: delivery.errorDetail,
                occurredAt: delivery.updatedAt,
                ...(delivery.usageLimit ? { usageLimit: delivery.usageLimit } : {}),
              }),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
  );

  yield* registerShutdown("provider-delivery-work", "drain", () => drain);

  const start: ProviderTurnDeliveryWorkerShape["start"] = Effect.gen(function* () {
    if (stopping) return;
    yield* Effect.addFinalizer(() => stopSources);
    yield* turns.reconcileAllAcceptedPendingTurnStarts.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("accepted pending turn startup reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* reconcileSending.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider delivery startup reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* replayTerminalOutcomes.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider delivery terminal replay failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* enqueueActionable.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider delivery startup replay failed", { cause: Cause.pretty(cause) }),
      ),
    );
    yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
      (event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-steer-requested") &&
      event.commandId !== null
        ? repository.getByCommandId(event.commandId).pipe(
            Effect.flatMap((delivery) => (delivery ? enqueue(delivery) : Effect.void)),
            Effect.catchCause((cause) =>
              Effect.logError("failed to enqueue durable provider delivery", {
                commandId: event.commandId,
                cause: Cause.pretty(cause),
              }),
            ),
          )
        : event.type === "thread.session-set" ||
            event.type === "thread.reverted" ||
            event.type === "thread.turn-diff-completed"
          ? enqueueActionable.pipe(
              Effect.catchCause((cause) => Effect.logWarning("delivery wake failed", { cause })),
            )
          : Effect.void,
    ).pipe(Effect.forkIn(sourceScope, { startImmediately: true }));
    yield* Stream.runForEach(Stream.fromPubSub(delayed), ([deliveryId, delayMs]) =>
      Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(enqueueById(deliveryId)),
        Effect.forkIn(sourceScope),
        Effect.asVoid,
      ),
    ).pipe(Effect.forkIn(sourceScope));
    yield* Effect.forever(
      enqueueActionable.pipe(
        Effect.andThen(replayTerminalOutcomes),
        Effect.catchCause((cause) =>
          Effect.logError("provider delivery safety sweep failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ).pipe(Effect.forkIn(sourceScope));
  });

  const getTargetDelivery = (threadId: ThreadId, deliveryId: CommandId) =>
    repository
      .getByCommandId(deliveryId)
      .pipe(Effect.map((delivery) => (delivery?.threadId === threadId ? delivery : null)));

  const recheck: ProviderTurnDeliveryWorkerShape["recheck"] = (threadId, deliveryId) =>
    Effect.gen(function* () {
      const delivery =
        deliveryId === undefined
          ? yield* repository.getLatestByThread(threadId)
          : yield* getTargetDelivery(threadId, deliveryId);
      if (!delivery) return null;
      if (
        delivery.state === "accepted" ||
        delivery.state === "abandoned" ||
        delivery.state === "pending" ||
        (delivery.state === "rejected" && delivery.certainty === "not_sent")
      ) {
        return delivery;
      }
      const snapshot = yield* provider.readThread(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider delivery recheck could not inspect provider history", {
            threadId,
            deliveryId: delivery.deliveryId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (!snapshot || delivery.event.type === "thread.turn-steer-requested") return delivery;
      const newTurnId = yield* findProvenProviderTurn(delivery);
      if (newTurnId === null) return delivery;
      yield* markAccepted({
        deliveryId: delivery.deliveryId,
        commandId: delivery.commandId,
        threadId,
        providerTurnId: newTurnId,
      });
      return {
        ...delivery,
        state: "accepted" as const,
        providerTurnId: newTurnId,
        errorCode: null,
        errorDetail: null,
        certainty: null,
        updatedAt: new Date().toISOString(),
      };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error("Could not recheck provider delivery.", { cause: error }),
      ),
    );

  const retry: ProviderTurnDeliveryWorkerShape["retry"] = (input) =>
    Effect.gen(function* () {
      const delivery =
        input.deliveryId === undefined
          ? yield* repository.getUnresolvedByThread(input.threadId)
          : yield* getTargetDelivery(input.threadId, input.deliveryId);
      if (!delivery) return yield* Effect.fail(new Error("No failed provider delivery exists."));
      const retried = yield* repository.retryTerminal({
        deliveryId: delivery.deliveryId,
        allowPossibleDuplicate: input.allowPossibleDuplicate,
      });
      if (!retried) {
        return yield* Effect.fail(
          new Error(
            delivery.state === "ambiguous"
              ? "Retrying an ambiguous delivery requires duplicate-risk confirmation."
              : "That provider delivery can no longer be retried.",
          ),
        );
      }
      yield* enqueue(retried);
      return retried;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error("Could not retry provider delivery.", { cause: error }),
      ),
    );

  const discard: ProviderTurnDeliveryWorkerShape["discard"] = (threadId, deliveryId) =>
    Effect.gen(function* () {
      const delivery =
        deliveryId === undefined
          ? yield* repository.getUnresolvedByThread(threadId)
          : yield* getTargetDelivery(threadId, deliveryId);
      if (!delivery || (delivery.state !== "rejected" && delivery.state !== "ambiguous")) {
        return yield* Effect.fail(new Error("No failed provider delivery exists."));
      }
      if (!(yield* repository.markAbandoned(delivery.deliveryId))) {
        return yield* Effect.fail(new Error("That provider delivery can no longer be discarded."));
      }
      // The thread holds one pending turn start. Remove it only when it belongs
      // to the discarded message, never a newer send's.
      const pending = yield* turns.getPendingTurnStartByThreadId({ threadId });
      if (Option.isSome(pending) && pending.value.messageId === delivery.messageId)
        yield* turns.deletePendingTurnStartByThreadId({ threadId });
      return delivery;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error("Could not discard provider delivery.", { cause: error }),
      ),
    );

  return {
    wakeScheduled: (threadId) =>
      Effect.gen(function* () {
        const rows = Option.isSome(scheduledSql)
          ? yield* scheduledSql.value<{
              deliveryId: CommandId;
            }>`SELECT delivery_id AS "deliveryId" FROM provider_turn_deliveries WHERE thread_id=${threadId} AND state='pending' ORDER BY created_at,delivery_id LIMIT 64`
          : (yield* repository.listActionable).filter((row) => row.threadId === threadId);
        yield* Effect.forEach(rows, (row) => enqueueById(row.deliveryId), { discard: true });
      }).pipe(Effect.ignore),
    start,
    // Starts can remain active while new steers arrive. Observe the steer lane
    // after the start lane drains so shutdown also waits for those deliveries.
    drain,
    outcomes: Stream.fromPubSub(outcomes),
    acknowledgeOutcome: (deliveryId) =>
      repository
        .markOutcomeProjected(deliveryId)
        .pipe(
          Effect.mapError((error) =>
            error instanceof Error
              ? error
              : new Error("Failed to acknowledge provider delivery outcome.", { cause: error }),
          ),
        ),
    recheck,
    retry,
    discard,
  } satisfies ProviderTurnDeliveryWorkerShape;
});

export const ProviderTurnDeliveryWorkerLive = Layer.effect(ProviderTurnDeliveryWorker, make);
