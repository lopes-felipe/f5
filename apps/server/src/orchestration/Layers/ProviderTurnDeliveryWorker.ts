import { CommandId, TurnId, type OrchestrationUsageLimit, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Duration, Effect, Layer, PubSub, Schema, Stream } from "effect";

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
  const provider = yield* ProviderService;
  const reactor = yield* ProviderCommandReactor;
  const turns = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngineService;
  const delayed = yield* PubSub.unbounded<readonly [CommandId, number]>();
  const outcomes = yield* PubSub.unbounded<ProviderTurnDeliveryOutcome>();

  const markAccepted = (input: {
    readonly deliveryId: CommandId;
    readonly commandId: CommandId;
    readonly threadId: ProviderTurnDeliveryOutcome["threadId"];
    readonly providerTurnId: TurnId;
  }) =>
    repository.markAccepted(input).pipe(
      Effect.andThen(reconcileAcceptedPendingTurnStartsBestEffort(turns, input.threadId)),
      Effect.andThen(
        PubSub.publish(outcomes, {
          deliveryId: input.deliveryId,
          commandId: input.commandId,
          threadId: input.threadId,
          state: "accepted",
          detail: null,
        }),
      ),
      Effect.asVoid,
    );

  const markRejected = (input: {
    readonly deliveryId: CommandId;
    readonly commandId: CommandId;
    readonly threadId: ProviderTurnDeliveryOutcome["threadId"];
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
    readonly usageLimit?: OrchestrationUsageLimit | undefined;
  }) =>
    Effect.gen(function* () {
      const occurredAt = new Date().toISOString();
      yield* repository.markRejected({ ...input, occurredAt });
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

  // A delivery is proven only by exactly one provider turn that did not exist
  // before the send and is not already attributed to another accepted
  // delivery. A newer accepted delivery on the same thread must never be
  // mistaken for this one.
  const findNewProviderTurn = (
    delivery: ProviderTurnDelivery,
    turns: ReadonlyArray<{ readonly id: TurnId }>,
  ) =>
    repository.listAcceptedTurnIdsByThread(delivery.threadId).pipe(
      Effect.map((claimedTurnIds) => {
        const excluded = new Set<TurnId>([...delivery.preSendTurnIds, ...claimedTurnIds]);
        const added = turns.filter((turn) => !excluded.has(turn.id));
        return added.length === 1 ? added[0]!.id : null;
      }),
    );

  const processDelivery = (deliveryId: CommandId) =>
    Effect.gen(function* () {
      const actionable = yield* repository.listActionable;
      const candidate = actionable.find((entry) => entry.deliveryId === deliveryId);
      if (!candidate) return;

      const preSendTurnIds = yield* provider.readThread(candidate.threadId).pipe(
        Effect.map((snapshot) => snapshot.turns.map((turn) => turn.id)),
        Effect.catchCause(() => Effect.succeed([] as TurnId[])),
      );
      const claimed = yield* repository.claim(deliveryId, preSendTurnIds);
      if (!claimed) return;
      if (
        claimed.event.type !== "thread.turn-start-requested" &&
        claimed.event.type !== "thread.turn-steer-requested"
      ) {
        yield* markRejected({
          deliveryId,
          commandId: claimed.commandId,
          threadId: claimed.threadId,
          errorCode: "invalid_event",
          errorDetail: "The durable delivery did not contain a turn-start event.",
          certainty: "not_sent",
          ambiguous: false,
        });
        return;
      }

      const exit = yield* Effect.exit(reactor.deliverTurnStart(claimed.event));
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
        claimed.attempt < 3
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
      if (!steering)
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
        commandId: claimed.commandId,
        threadId: claimed.threadId,
        errorCode:
          error && typeof error === "object" && "_tag" in error ? String(error._tag) : "unknown",
        errorDetail: detail,
        certainty: notSent ? "not_sent" : "unknown",
        ambiguous: !notSent,
        ...(usageLimit ? { usageLimit } : {}),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("provider turn delivery worker failed", {
              deliveryId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  // ACP starts await the entire prompt. Steers must reach the adapter while
  // that prompt is in flight; each lane retains its own delivery order.
  const worker = yield* makeDrainableWorker(processDelivery);
  const steerWorker = yield* makeDrainableWorker(processDelivery);
  const enqueue = (delivery: { deliveryId: CommandId; event: { type: string } }) =>
    (delivery.event.type === "thread.turn-steer-requested" ? steerWorker : worker).enqueue(
      delivery.deliveryId,
    );
  const enqueueById = (deliveryId: CommandId) =>
    repository
      .getByCommandId(deliveryId)
      .pipe(Effect.flatMap((delivery) => (delivery ? enqueue(delivery) : Effect.void)));

  const reconcileSending = Effect.gen(function* () {
    const sending = yield* repository.listSending;
    yield* Effect.forEach(
      sending,
      (delivery) =>
        provider.readThread(delivery.threadId).pipe(
          Effect.flatMap((snapshot) => findNewProviderTurn(delivery, snapshot.turns)),
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
  });

  const enqueueActionable = repository.listActionable.pipe(
    Effect.flatMap((deliveries) =>
      Effect.forEach(deliveries, (delivery) => enqueue(delivery), {
        discard: true,
      }),
    ),
  );

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

  const start: ProviderTurnDeliveryWorkerShape["start"] = Effect.gen(function* () {
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
        : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(Stream.fromPubSub(delayed), ([deliveryId, delayMs]) =>
      Effect.sleep(Duration.millis(delayMs)).pipe(
        Effect.andThen(enqueueById(deliveryId)),
        Effect.forkScoped,
        Effect.asVoid,
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(enqueueActionable.pipe(Effect.andThen(Effect.sleep("5 seconds")))).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("provider delivery safety sweep failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
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
      const newTurnId = yield* findNewProviderTurn(delivery, snapshot.turns);
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
      yield* repository.markAbandoned(delivery.deliveryId);
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
    start,
    // Starts can remain active while new steers arrive. Observe the steer lane
    // after the start lane drains so shutdown also waits for those deliveries.
    drain: worker.drain.pipe(Effect.andThen(steerWorker.drain)),
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
