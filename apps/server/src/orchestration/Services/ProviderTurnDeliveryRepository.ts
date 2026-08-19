import {
  CommandId,
  MessageId,
  NonNegativeInt,
  OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export const ProviderTurnDeliveryState = Schema.Literals([
  "pending",
  "sending",
  "accepted",
  "rejected",
  "ambiguous",
  "abandoned",
]);
export type ProviderTurnDeliveryState = typeof ProviderTurnDeliveryState.Type;

export const ProviderTurnDelivery = Schema.Struct({
  deliveryId: CommandId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  state: ProviderTurnDeliveryState,
  providerTurnId: Schema.NullOr(TurnId),
  attempt: NonNegativeInt,
  preSendTurnIds: Schema.Array(TurnId),
  event: OrchestrationEvent,
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
  certainty: Schema.NullOr(Schema.Literals(["not_sent", "unknown"])),
  notBefore: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  outcomeProjectedAt: Schema.NullOr(Schema.String),
});
export type ProviderTurnDelivery = typeof ProviderTurnDelivery.Type;

export type ProviderTurnDeliveryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderTurnDeliveryRepositoryShape {
  readonly listActionable: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly listSending: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly listUnprojectedTerminal: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly getLatestByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly getUnresolvedByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly claim: (
    deliveryId: CommandId,
    preSendTurnIds: ReadonlyArray<TurnId>,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly markAccepted: (input: {
    readonly deliveryId: CommandId;
    readonly providerTurnId: TurnId;
  }) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
  readonly markRejected: (input: {
    readonly deliveryId: CommandId;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
  }) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
  readonly requeue: (input: {
    readonly deliveryId: CommandId;
    readonly notBefore: string;
    readonly errorCode: string;
    readonly errorDetail: string;
  }) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
  readonly retryTerminal: (input: {
    readonly deliveryId: CommandId;
    readonly allowPossibleDuplicate: boolean;
  }) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly markAbandoned: (
    deliveryId: CommandId,
  ) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
  readonly markOutcomeProjected: (
    deliveryId: CommandId,
  ) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
}

export class ProviderTurnDeliveryRepository extends ServiceMap.Service<
  ProviderTurnDeliveryRepository,
  ProviderTurnDeliveryRepositoryShape
>()("t3/orchestration/Services/ProviderTurnDeliveryRepository") {}
