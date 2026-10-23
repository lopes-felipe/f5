import { CommandId } from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, ServiceMap } from "effect";
import { ProviderNativeHistory } from "../../provider/ProviderNativeHistory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

export class ProviderNativeHistoryWorker extends ServiceMap.Service<
  ProviderNativeHistoryWorker,
  {
    readonly start: Effect.Effect<void, never, import("effect").Scope.Scope>;
  }
>()("t3/orchestration/Layers/ProviderNativeHistory/ProviderNativeHistoryWorker") {}
export const ProviderNativeHistoryWorkerLive = Layer.effect(
  ProviderNativeHistoryWorker,
  Effect.gen(function* () {
    const broker = yield* Effect.serviceOption(ProviderNativeHistory);
    if (Option.isNone(broker)) return { start: Effect.void };
    const engine = yield* OrchestrationEngineService;
    return {
      start: broker.value.install((request) =>
        Effect.gen(function* () {
          // Native settlement may precede runtime ingestion. The broker's deadline
          // bounds this wait, and the decider fences the eventual command again.
          while (yield* request.isCurrent) {
            const thread = (yield* engine.getReadModel()).threads.find(
              (thread) => thread.id === request.threadId,
            );
            if (
              !thread ||
              thread.deletedAt ||
              thread.archivedAt ||
              thread.session?.providerInstanceId !== request.providerInstanceId
            )
              return false;
            if (thread.latestTurn?.turnId !== request.turnId) {
              yield* Effect.sleep("25 millis");
              continue;
            }
            yield* engine.dispatch({
              type: "thread.native-history.reconcile",
              commandId: CommandId.make(request.requestId),
              threadId: request.threadId,
              providerInstanceId: request.providerInstanceId,
              expectedTurnId: request.turnId,
              removedTurnIds: request.removedTurnIds,
              createdAt: new Date().toISOString(),
            });
            return yield* request.isCurrent;
          }
          return false;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Native conversation history could not be reconciled.", {
                  threadId: request.threadId,
                }).pipe(Effect.as(false)),
          ),
        ),
      ),
    };
  }),
);
