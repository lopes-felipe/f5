import {
  EventId,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ProviderTerminalRuntimeEvent = Extract<
  ProviderRuntimeEvent,
  { type: "turn.completed" | "session.exited" }
>;

export const isProviderTerminalRuntimeEvent = (
  event: ProviderRuntimeEvent,
): event is ProviderTerminalRuntimeEvent =>
  event.type === "turn.completed" || event.type === "session.exited";

export const ProviderTerminalEventReceipt = Schema.Struct({
  eventId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  eventType: Schema.Literals(["turn.completed", "session.exited"]),
  event: ProviderRuntimeEvent,
  receivedAt: Schema.String,
  appliedAt: Schema.NullOr(Schema.String),
  attempt: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  originProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  originSessionGeneration: Schema.NullOr(NonNegativeInt),
  originTurnId: Schema.NullOr(TurnId),
  nextDueAt: Schema.String,
});
export type ProviderTerminalEventReceipt = typeof ProviderTerminalEventReceipt.Type;

export type ProviderTerminalEventRepositoryError = PersistenceSqlError | PersistenceDecodeError;

// Migration 126 partial-index predicates use literals for query planning.
// 124_ProviderTerminalRetry.test.ts verifies this limit matches both indexes.
export const MAX_TERMINAL_RECEIPT_ATTEMPTS = 10;
export interface TerminalReceiptOrigin {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly sessionGeneration: number;
}

export interface ProviderTerminalEventRepositoryShape {
  readonly record: (
    event: ProviderTerminalRuntimeEvent,
  ) => Effect.Effect<void, ProviderTerminalEventRepositoryError>;
  readonly listPendingPage: Effect.Effect<
    ReadonlyArray<ProviderTerminalEventReceipt>,
    ProviderTerminalEventRepositoryError
  >;
  readonly listDue: (
    now?: string,
  ) => Effect.Effect<
    ReadonlyArray<ProviderTerminalEventReceipt>,
    ProviderTerminalEventRepositoryError
  >;
  readonly hasPending: (
    threadId: ThreadId,
    turnId: TurnId | null,
    origin: TerminalReceiptOrigin,
  ) => Effect.Effect<boolean, ProviderTerminalEventRepositoryError>;
  readonly hasExhausted: (
    threadId?: ThreadId,
  ) => Effect.Effect<boolean, ProviderTerminalEventRepositoryError>;
  /** Null requests a full reconciliation after the bounded dirty set overflowed. */
  readonly takeRecoveryThreadIds: Effect.Effect<
    ReadonlyArray<ThreadId> | null,
    ProviderTerminalEventRepositoryError
  >;
  readonly markApplied: (
    eventId: EventId,
  ) => Effect.Effect<void, ProviderTerminalEventRepositoryError>;
  readonly markFailed: (input: {
    readonly eventId: EventId;
    readonly error: string;
  }) => Effect.Effect<void, ProviderTerminalEventRepositoryError>;
}

export class ProviderTerminalEventRepository extends ServiceMap.Service<
  ProviderTerminalEventRepository,
  ProviderTerminalEventRepositoryShape
>()("t3/persistence/Services/ProviderTerminalEvents/ProviderTerminalEventRepository") {}
