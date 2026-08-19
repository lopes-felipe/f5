import { CommandId, TurnId } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Duration, Effect, Layer, PubSub, Schema, Stream } from "effect";

import { ProviderTurnDeliveryError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
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
  }) =>
    repository.markRejected(input).pipe(
      Effect.andThen(
        PubSub.publish(outcomes, {
          deliveryId: input.deliveryId,
          commandId: input.commandId,
          threadId: input.threadId,
          state: input.ambiguous ? "ambiguous" : "rejected",
          detail: input.errorDetail,
        }),
      ),
      Effect.asVoid,
    );

  let worker: DrainableWorker<CommandId>;

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
      if (claimed.event.type !== "thread.turn-start-requested") {
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
      const notSent = typedDeliveryError?.certainty === "not_sent";
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
        "The provider delivery outcome is unknown. Recheck provider history before retrying.";
      if (notSent && typedDeliveryError?.retryable === true && claimed.attempt < 3) {
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
      yield* reactor.recordTurnStartFailure(claimed.event, detail).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to record terminal provider delivery error", {
            deliveryId,
            threadId: claimed.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* markRejected({
        deliveryId,
        commandId: claimed.commandId,
        threadId: claimed.threadId,
        errorCode:
          error && typeof error === "object" && "_tag" in error ? String(error._tag) : "unknown",
        errorDetail: detail,
        certainty: notSent ? "not_sent" : "unknown",
        ambiguous: !notSent,
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

  worker = yield* makeDrainableWorker(processDelivery);

  const reconcileSending = Effect.gen(function* () {
    const sending = yield* repository.listSending;
    yield* Effect.forEach(
      sending,
      (delivery) =>
        provider.readThread(delivery.threadId).pipe(
          Effect.flatMap((snapshot) => {
            const before = new Set(delivery.preSendTurnIds);
            const added = snapshot.turns.filter((turn) => !before.has(turn.id));
            return added.length === 1
              ? markAccepted({
                  deliveryId: delivery.deliveryId,
                  commandId: delivery.commandId,
                  threadId: delivery.threadId,
                  providerTurnId: added[0]!.id,
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
      Effect.forEach(deliveries, (delivery) => worker.enqueue(delivery.deliveryId), {
        discard: true,
      }),
    ),
  );

  const replayTerminalOutcomes = repository.listUnprojectedTerminal.pipe(
    Effect.flatMap((deliveries) =>
      Effect.forEach(
        deliveries,
        (delivery) =>
          PubSub.publish(outcomes, {
            deliveryId: delivery.deliveryId,
            commandId: delivery.commandId,
            threadId: delivery.threadId,
            state: delivery.state as "accepted" | "rejected" | "ambiguous",
            detail: delivery.errorDetail,
          }),
        { concurrency: 1, discard: true },
      ),
    ),
  );

  const start: ProviderTurnDeliveryWorkerShape["start"] = Effect.gen(function* () {
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
      event.type === "thread.turn-start-requested" && event.commandId !== null
        ? repository.getByCommandId(event.commandId).pipe(
            Effect.flatMap((delivery) =>
              delivery ? worker.enqueue(delivery.deliveryId) : Effect.void,
            ),
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
        Effect.andThen(worker.enqueue(deliveryId)),
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

  const recheck: ProviderTurnDeliveryWorkerShape["recheck"] = (threadId) =>
    Effect.gen(function* () {
      const delivery = yield* repository.getLatestByThread(threadId);
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
      if (!snapshot) return delivery;
      const before = new Set(delivery.preSendTurnIds);
      const added = snapshot.turns.filter((turn) => !before.has(turn.id));
      if (added.length !== 1) return delivery;
      yield* markAccepted({
        deliveryId: delivery.deliveryId,
        commandId: delivery.commandId,
        threadId,
        providerTurnId: added[0]!.id,
      });
      return {
        ...delivery,
        state: "accepted" as const,
        providerTurnId: added[0]!.id,
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
      const delivery = yield* repository.getUnresolvedByThread(input.threadId);
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
      yield* worker.enqueue(retried.deliveryId);
      return retried;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error("Could not retry provider delivery.", { cause: error }),
      ),
    );

  const discard: ProviderTurnDeliveryWorkerShape["discard"] = (threadId) =>
    Effect.gen(function* () {
      const delivery = yield* repository.getUnresolvedByThread(threadId);
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
    drain: worker.drain,
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
