import {
  BackgroundWorkClassification,
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
  status: BackgroundWorkStatus,
  active: Schema.Boolean,
  model: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  phase: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  latestOutput: Schema.optional(Schema.NullOr(Schema.String)),
  outputTruncated: Schema.optional(Schema.Boolean),
  occurredAt: IsoDateTime,
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
  readonly listSnapshot: () => Effect.Effect<
    ReadonlyArray<ThreadBackgroundWorkEntry>,
    ProjectionRepositoryError
  >;
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
