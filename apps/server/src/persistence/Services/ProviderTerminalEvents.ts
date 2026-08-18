import {
  EventId,
  NonNegativeInt,
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
});
export type ProviderTerminalEventReceipt = typeof ProviderTerminalEventReceipt.Type;

export type ProviderTerminalEventRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderTerminalEventRepositoryShape {
  readonly record: (
    event: ProviderTerminalRuntimeEvent,
  ) => Effect.Effect<void, ProviderTerminalEventRepositoryError>;
  readonly listPending: Effect.Effect<
    ReadonlyArray<ProviderTerminalEventReceipt>,
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
