import {
  BackgroundWorkClassification,
  BackgroundWorkKind,
  BackgroundWorkOwnership,
  BackgroundWorkStatus,
  IsoDateTime,
  ProviderInstanceId,
  ProviderKind,
  ThreadBackgroundWorkEntry,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ThreadBackgroundWorkTransition = Schema.Struct({
  threadId: ThreadId,
  workItemId: TrimmedNonEmptyString,
  provider: ProviderKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  providerSessionIdentity: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
  classification: Schema.optional(BackgroundWorkClassification),
  ownership: Schema.optional(BackgroundWorkOwnership),
  kind: Schema.optional(BackgroundWorkKind),
  status: BackgroundWorkStatus,
  active: Schema.Boolean,
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  effort: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64)))),
  phase: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.optional(Schema.NullOr(Schema.String)),
  lastTool: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  latestOutput: Schema.optional(Schema.NullOr(Schema.String)),
  outputTruncated: Schema.optional(Schema.Boolean),
  occurredAt: IsoDateTime,
  progressOnly: Schema.optional(Schema.Boolean),
});
export type ThreadBackgroundWorkTransition = typeof ThreadBackgroundWorkTransition.Type;

export const ThreadBackgroundWorkFreshnessInput = Schema.Struct({
  freshSince: IsoDateTime,
});
export type ThreadBackgroundWorkFreshnessInput = typeof ThreadBackgroundWorkFreshnessInput.Type;

export const ThreadBackgroundWorkThreadFreshnessInput = Schema.Struct({
  threadId: ThreadId,
  freshSince: IsoDateTime,
});
export type ThreadBackgroundWorkThreadFreshnessInput =
  typeof ThreadBackgroundWorkThreadFreshnessInput.Type;

export const ExpireThreadBackgroundWorkInput = Schema.Struct({
  freshSince: IsoDateTime,
  expiredAt: IsoDateTime,
});
export type ExpireThreadBackgroundWorkInput = typeof ExpireThreadBackgroundWorkInput.Type;

export const MarkThreadBackgroundWorkInactiveInput = Schema.Struct({
  threadId: ThreadId,
  completedAt: IsoDateTime,
});
export type MarkThreadBackgroundWorkInactiveInput =
  typeof MarkThreadBackgroundWorkInactiveInput.Type;

export const ListThreadBackgroundWorkSnapshotInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type ListThreadBackgroundWorkSnapshotInput =
  typeof ListThreadBackgroundWorkSnapshotInput.Type;

export const DismissThreadBackgroundWorkInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  workItemIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  dismissedAt: IsoDateTime,
});
export type DismissThreadBackgroundWorkInput = typeof DismissThreadBackgroundWorkInput.Type;

export interface ThreadBackgroundWorkRepositoryShape {
  readonly upsertTransition: (
    transition: ThreadBackgroundWorkTransition,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markThreadInactive: (
    input: MarkThreadBackgroundWorkInactiveInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly expireStale: (
    input: ExpireThreadBackgroundWorkInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Visible (non-dismissed) work, active first, capped at the snapshot limit. */
  readonly listSnapshot: (
    input?: ListThreadBackgroundWorkSnapshotInput,
  ) => Effect.Effect<ReadonlyArray<ThreadBackgroundWorkEntry>, ProjectionRepositoryError>;
  /** Hides settled work from snapshots; active rows are never dismissed. */
  readonly dismiss: (
    input: DismissThreadBackgroundWorkInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly listProtectedThreadIds: (
    input: ThreadBackgroundWorkFreshnessInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;
  readonly hasFreshProtectingWork: (
    input: ThreadBackgroundWorkThreadFreshnessInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly prune: () => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ThreadBackgroundWorkRepository extends ServiceMap.Service<
  ThreadBackgroundWorkRepository,
  ThreadBackgroundWorkRepositoryShape
>()("t3/persistence/Services/ThreadBackgroundWork/ThreadBackgroundWorkRepository") {}
