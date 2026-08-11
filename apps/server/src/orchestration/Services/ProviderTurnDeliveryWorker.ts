import type { CommandId, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";
import type { ProviderTurnDelivery } from "./ProviderTurnDeliveryRepository.ts";

export interface ProviderTurnDeliveryOutcome {
  readonly deliveryId: CommandId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly state: "accepted" | "rejected" | "ambiguous";
  readonly detail: string | null;
}

export interface ProviderTurnDeliveryWorkerShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly outcomes: Stream.Stream<ProviderTurnDeliveryOutcome>;
  readonly acknowledgeOutcome: (deliveryId: CommandId) => Effect.Effect<void, Error>;
  readonly recheck: (threadId: ThreadId) => Effect.Effect<ProviderTurnDelivery | null, Error>;
  readonly retry: (input: {
    readonly threadId: ThreadId;
    readonly allowPossibleDuplicate: boolean;
  }) => Effect.Effect<ProviderTurnDelivery, Error>;
  readonly discard: (threadId: ThreadId) => Effect.Effect<ProviderTurnDelivery, Error>;
}

export class ProviderTurnDeliveryWorker extends ServiceMap.Service<
  ProviderTurnDeliveryWorker,
  ProviderTurnDeliveryWorkerShape
>()("t3/orchestration/Services/ProviderTurnDeliveryWorker") {}
