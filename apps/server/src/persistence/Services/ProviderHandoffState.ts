/**
 * ProviderHandoffStateRepository - Cross-provider context handoff state per thread.
 *
 * `pending` marks history the active provider session has not received yet.
 * `parked` keeps the native sessions of earlier providers so switching back can
 * resume them and send only what happened while they were away.
 *
 * @module ProviderHandoffStateRepository
 */
import { MessageId, ProviderInstanceId, ProviderKind, ThreadId } from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const ProviderHandoffMode = Schema.Literals(["full", "delta"]);
export type ProviderHandoffMode = typeof ProviderHandoffMode.Type;

export const PendingProviderHandoff = Schema.Struct({
  id: Schema.String,
  mode: ProviderHandoffMode,
  targetInstanceId: ProviderInstanceId,
  fromProvider: ProviderKind,
  fromInstanceId: ProviderInstanceId,
  fromModel: Schema.NullOr(Schema.String),
  /** Delta only: the last message the target session saw before it was parked. */
  sinceMessageId: Schema.NullOr(MessageId),
  /** The native session the marker was prepared for; null until the target started. */
  expectedNativeIdentity: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type PendingProviderHandoff = typeof PendingProviderHandoff.Type;

export const ParkedNativeSession = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: ProviderInstanceId,
  resumeCursor: Schema.Unknown,
  nativeIdentity: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  lastSeenMessageId: MessageId,
  estimatedContextTokens: Schema.NullOr(Schema.Number),
  parkedAt: Schema.String,
});
export type ParkedNativeSession = typeof ParkedNativeSession.Type;

/** Parked sessions keyed by exact provider instance id. */
export type ParkedNativeSessions = Readonly<Record<string, ParkedNativeSession>>;

/**
 * A native session discarded without being resumed. Its transcript is no longer
 * reachable from the thread, so thread deletion cleans it up with the rest.
 */
export const RetiredNativeSession = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: ProviderInstanceId,
  resumeCursor: Schema.Unknown,
  retiredAt: Schema.String,
});
export type RetiredNativeSession = typeof RetiredNativeSession.Type;

export interface ProviderHandoffState {
  readonly threadId: ThreadId;
  readonly pending: PendingProviderHandoff | null;
  readonly parked: ParkedNativeSessions;
  readonly retired: ReadonlyArray<RetiredNativeSession>;
  readonly revision: number;
  readonly updatedAt: string;
}

export type ProviderHandoffStateRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderHandoffStateRepositoryShape {
  readonly get: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderHandoffState | null, ProviderHandoffStateRepositoryError>;
  /**
   * Writes the state only when the stored revision still equals
   * `expectedRevision` (`null` inserts a new row). Returns the written state, or
   * null when another writer won.
   */
  readonly compareAndSet: (input: {
    readonly threadId: ThreadId;
    readonly expectedRevision: number | null;
    readonly pending: PendingProviderHandoff | null;
    readonly parked: ParkedNativeSessions;
  }) => Effect.Effect<ProviderHandoffState | null, ProviderHandoffStateRepositoryError>;
  /**
   * Appends discarded sessions to an existing row. Outside the revision fence:
   * it never races the pending marker or the parked sessions.
   */
  readonly retire: (input: {
    readonly threadId: ThreadId;
    readonly sessions: ReadonlyArray<RetiredNativeSession>;
  }) => Effect.Effect<void, ProviderHandoffStateRepositoryError>;
  readonly deleteByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderHandoffStateRepositoryError>;
  readonly listAll: Effect.Effect<
    ReadonlyArray<ProviderHandoffState>,
    ProviderHandoffStateRepositoryError
  >;
}

export class ProviderHandoffStateRepository extends ServiceMap.Service<
  ProviderHandoffStateRepository,
  ProviderHandoffStateRepositoryShape
>()("t3/persistence/Services/ProviderHandoffState/ProviderHandoffStateRepository") {}
