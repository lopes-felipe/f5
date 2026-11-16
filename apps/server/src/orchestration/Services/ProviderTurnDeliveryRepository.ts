import {
  CommandId,
  OrchestrationUsageLimit,
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

export const DeliveryHistoryEvidence = Schema.Struct({
  sessionOrigin: Schema.optional(Schema.Literals(["fresh", "resumed", "unknown"])),
  identity: Schema.NullOr(Schema.String),
  provenance: Schema.Literals(["provider-persisted", "runtime-local", "unavailable"]),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
  boundary: Schema.NullOr(Schema.String),
  runtimeId: Schema.NullOr(Schema.String),
});

export const DeliveryAcceptanceReceipt = Schema.Struct({
  turnId: TurnId,
  attemptId: Schema.String,
  runtimeGeneration: Schema.Number,
  nativeHistoryIdentity: Schema.NullOr(Schema.String),
  acceptedAt: Schema.String,
});

/**
 * The prepared cross-provider handoff of one delivery. Retries reuse it
 * byte-for-byte; `consumed` clears the matching pending marker atomically with
 * the acceptance receipt, while `deferred` (a native command, or no history
 * fitting the request) keeps it for a later turn. `block` is cleared to a
 * manifest once the delivery settles and falls out of retention.
 */
export const DeliveryHandoff = Schema.Struct({
  id: Schema.String,
  rendererVersion: Schema.Number,
  disposition: Schema.Literals(["consumed", "deferred"]),
  fromProvider: Schema.String,
  fromInstanceId: Schema.String,
  fromModel: Schema.NullOr(Schema.String),
  toProvider: Schema.String,
  toInstanceId: Schema.String,
  toModel: Schema.NullOr(Schema.String),
  requestedMode: Schema.Literals(["full", "delta"]),
  effectiveMode: Schema.Literals(["full", "delta"]),
  messageIds: Schema.Array(Schema.String),
  includedCount: Schema.Number,
  omittedCount: Schema.Number,
  summaryIncluded: Schema.Boolean,
  block: Schema.NullOr(Schema.String),
});
export type DeliveryHandoff = typeof DeliveryHandoff.Type;

/** Settled deliveries per thread whose rendered handoff text is retained. */
export const DELIVERY_HANDOFF_BODY_RETENTION = 20;

export const ProviderTurnDelivery = Schema.Struct({
  deliveryId: CommandId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  state: ProviderTurnDeliveryState,
  providerTurnId: Schema.NullOr(TurnId),
  attempt: NonNegativeInt,
  preSendTurnIds: Schema.Array(TurnId),
  acceptanceReceipt: Schema.optional(Schema.NullOr(DeliveryAcceptanceReceipt)),
  attemptId: Schema.optional(Schema.NullOr(Schema.String)),
  historyEvidence: Schema.optional(Schema.NullOr(DeliveryHistoryEvidence)),
  handoff: Schema.optional(Schema.NullOr(DeliveryHandoff)),
  event: OrchestrationEvent,
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
  usageLimit: Schema.optional(Schema.NullOr(OrchestrationUsageLimit)),
  certainty: Schema.NullOr(Schema.Literals(["not_sent", "unknown"])),
  notBefore: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  outcomeProjectedAt: Schema.NullOr(Schema.String),
});
export type ProviderTurnDelivery = typeof ProviderTurnDelivery.Type;

export type ProviderTurnDeliveryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderTurnDeliveryRepositoryShape {
  readonly listCandidateIds: (input: {
    readonly afterThreadId: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly deliveryId: CommandId; readonly threadId: ThreadId }>,
    ProviderTurnDeliveryRepositoryError
  >;
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
  /** Provider turns already attributed to accepted deliveries on this thread. */
  readonly listAcceptedTurnIdsByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<TurnId>, ProviderTurnDeliveryRepositoryError>;
  /**
   * The pre-send turn snapshot of the earliest newer delivery on the same
   * thread that has been claimed. Turns outside it may belong to that newer
   * send. Null when no newer delivery has been claimed.
   */
  readonly getSupersedingPreSendTurnIds: (
    deliveryId: CommandId,
  ) => Effect.Effect<ReadonlyArray<TurnId> | null, ProviderTurnDeliveryRepositoryError>;
  readonly recordDispatchIntent: (input: {
    readonly deliveryId: CommandId;
    readonly attemptId: string;
    readonly preSendTurnIds: ReadonlyArray<TurnId>;
    readonly historyEvidence: typeof DeliveryHistoryEvidence.Type | null;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  /**
   * Stores the prepared handoff once per delivery, fenced to the claiming
   * attempt. Returns the stored payload: the new one, or one an earlier attempt
   * of the same delivery already wrote. Null when the attempt no longer owns it.
   * `replace` overwrites an earlier attempt's payload that is no longer safe to
   * send; only an attempt that owns dispatch can, and nothing was accepted yet.
   */
  readonly recordHandoff: (input: {
    readonly deliveryId: CommandId;
    readonly attemptId: string;
    readonly handoff: DeliveryHandoff;
    readonly replace?: boolean;
  }) => Effect.Effect<DeliveryHandoff | null, ProviderTurnDeliveryRepositoryError>;
  readonly claim: (
    deliveryId: CommandId,
    preSendTurnIds: ReadonlyArray<TurnId>,
    historyEvidence?: typeof DeliveryHistoryEvidence.Type | null,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly markAccepted: (input: {
    readonly deliveryId: CommandId;
    readonly providerTurnId: TurnId;
    readonly receipt?: typeof DeliveryAcceptanceReceipt.Type | undefined;
    readonly attemptId?: string | null | undefined;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly markRejected: (input: {
    readonly deliveryId: CommandId;
    readonly attemptId?: string | null | undefined;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
    readonly occurredAt?: string | undefined;
    readonly usageLimit?: OrchestrationUsageLimit | undefined;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
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
  /** Returns false when the delivery was no longer rejected or ambiguous. */
  readonly markAbandoned: (
    deliveryId: CommandId,
  ) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly markOutcomeProjected: (
    deliveryId: CommandId,
  ) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
}

export class ProviderTurnDeliveryRepository extends ServiceMap.Service<
  ProviderTurnDeliveryRepository,
  ProviderTurnDeliveryRepositoryShape
>()("t3/orchestration/Services/ProviderTurnDeliveryRepository") {}
