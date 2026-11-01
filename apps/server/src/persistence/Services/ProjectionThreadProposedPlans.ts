import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProposedPlan = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlan = typeof ProjectionThreadProposedPlan.Type;

export const ListProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadProposedPlansInput =
  typeof ListProjectionThreadProposedPlansInput.Type;

export const DeleteProjectionThreadProposedPlansInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadProposedPlansInput =
  typeof DeleteProjectionThreadProposedPlansInput.Type;

/** A proposed plan read as context for another thread, with its markdown bounded in SQL. */
export const ProjectionThreadProposedPlanContext = Schema.Struct({
  planId: OrchestrationProposedPlanId,
  text: Schema.String,
  /** Length of the full markdown in code points, matching SQLite `length`. */
  totalLength: NonNegativeInt,
  implementedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProposedPlanContext = typeof ProjectionThreadProposedPlanContext.Type;

export const GetProjectionThreadProposedPlanContextItemInput = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
  /** Code points to skip. */
  offset: NonNegativeInt,
});
export type GetProjectionThreadProposedPlanContextItemInput =
  typeof GetProjectionThreadProposedPlanContextItemInput.Type;

export interface ProjectionThreadProposedPlanRepositoryShape {
  readonly upsert: (
    proposedPlan: ProjectionThreadProposedPlan,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadProposedPlansInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProposedPlan>, ProjectionRepositoryError>;
  /** The thread's latest proposed plan with a preview of its markdown. */
  readonly getLatestContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadProposedPlanContext>, ProjectionRepositoryError>;
  /** One chunk of a proposed plan's markdown, scoped to its thread. */
  readonly getContextItem: (
    input: GetProjectionThreadProposedPlanContextItemInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadProposedPlanContext>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadProposedPlansInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProposedPlanRepository extends ServiceMap.Service<
  ProjectionThreadProposedPlanRepository,
  ProjectionThreadProposedPlanRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadProposedPlans/ProjectionThreadProposedPlanRepository",
) {}
