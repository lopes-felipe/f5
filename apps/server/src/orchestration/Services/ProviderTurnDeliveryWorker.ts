import type { CommandId, ThreadId, OrchestrationUsageLimit } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";
import type { ProviderTurnDelivery } from "./ProviderTurnDeliveryRepository.ts";

export interface ProviderTurnDeliveryOutcome {
  readonly deliveryId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly state: "accepted" | "rejected" | "ambiguous";
  readonly detail: string | null;
  readonly occurredAt?: string | undefined;
  readonly usageLimit?: OrchestrationUsageLimit | undefined;
}

export interface ProviderTurnDeliveryWorkerShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly outcomes: Stream.Stream<ProviderTurnDeliveryOutcome>;
  readonly acknowledgeOutcome: (deliveryId: CommandId) => Effect.Effect<void, Error>;
  /**
   * Rechecks `deliveryId` when given, otherwise the thread's latest delivery.
   * Queue recovery passes the delivery that paused the queue, which may have
   * been superseded by a newer delivery on the same thread.
   */
  readonly recheck: (
    threadId: ThreadId,
    deliveryId?: CommandId,
  ) => Effect.Effect<ProviderTurnDelivery | null, Error>;
  /** Targets `deliveryId` when given, otherwise the thread's unresolved delivery. */
  readonly retry: (input: {
    readonly threadId: ThreadId;
    readonly allowPossibleDuplicate: boolean;
    readonly deliveryId?: CommandId | undefined;
  }) => Effect.Effect<ProviderTurnDelivery, Error>;
  /** Targets `deliveryId` when given, otherwise the thread's unresolved delivery. */
  readonly discard: (
    threadId: ThreadId,
    deliveryId?: CommandId,
  ) => Effect.Effect<ProviderTurnDelivery, Error>;
}

export class ProviderTurnDeliveryWorker extends ServiceMap.Service<
  ProviderTurnDeliveryWorker,
  ProviderTurnDeliveryWorkerShape
>()("t3/orchestration/Services/ProviderTurnDeliveryWorker") {}
