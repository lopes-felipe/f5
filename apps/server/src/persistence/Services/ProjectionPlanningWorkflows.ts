import { IsoDateTime, ProjectId } from "@t3tools/contracts";
import { PlanningWorkflow, PlanningWorkflowId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPlanningWorkflow = PlanningWorkflow;
export type ProjectionPlanningWorkflow = typeof ProjectionPlanningWorkflow.Type;

export const GetProjectionPlanningWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
});
export type GetProjectionPlanningWorkflowInput = typeof GetProjectionPlanningWorkflowInput.Type;

export const ListProjectionPlanningWorkflowsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionPlanningWorkflowsByProjectInput =
  typeof ListProjectionPlanningWorkflowsByProjectInput.Type;

export const DeleteProjectionPlanningWorkflowInput = Schema.Struct({
  workflowId: PlanningWorkflowId,
  deletedAt: IsoDateTime,
});
export type DeleteProjectionPlanningWorkflowInput =
  typeof DeleteProjectionPlanningWorkflowInput.Type;

export interface ProjectionPlanningWorkflowRepositoryShape {
  readonly upsert: (
    workflow: ProjectionPlanningWorkflow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionPlanningWorkflowInput,
  ) => Effect.Effect<Option.Option<ProjectionPlanningWorkflow>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionPlanningWorkflowsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPlanningWorkflow>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionPlanningWorkflow>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteProjectionPlanningWorkflowInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionPlanningWorkflowRepository extends ServiceMap.Service<
  ProjectionPlanningWorkflowRepository,
  ProjectionPlanningWorkflowRepositoryShape
>()("t3/persistence/Services/ProjectionPlanningWorkflows/ProjectionPlanningWorkflowRepository") {}
