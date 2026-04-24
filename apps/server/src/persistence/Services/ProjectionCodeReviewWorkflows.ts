import {
  CodeReviewWorkflow,
  CodeReviewWorkflowId,
  IsoDateTime,
  ProjectId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCodeReviewWorkflow = CodeReviewWorkflow;
export type ProjectionCodeReviewWorkflow = typeof ProjectionCodeReviewWorkflow.Type;

export const GetProjectionCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
});
export type GetProjectionCodeReviewWorkflowInput = typeof GetProjectionCodeReviewWorkflowInput.Type;

export const ListProjectionCodeReviewWorkflowsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionCodeReviewWorkflowsByProjectInput =
  typeof ListProjectionCodeReviewWorkflowsByProjectInput.Type;

export const DeleteProjectionCodeReviewWorkflowInput = Schema.Struct({
  workflowId: CodeReviewWorkflowId,
  deletedAt: IsoDateTime,
});
export type DeleteProjectionCodeReviewWorkflowInput =
  typeof DeleteProjectionCodeReviewWorkflowInput.Type;

export interface ProjectionCodeReviewWorkflowRepositoryShape {
  readonly upsert: (
    workflow: ProjectionCodeReviewWorkflow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionCodeReviewWorkflowInput,
  ) => Effect.Effect<Option.Option<ProjectionCodeReviewWorkflow>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionCodeReviewWorkflowsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCodeReviewWorkflow>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionCodeReviewWorkflow>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteProjectionCodeReviewWorkflowInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionCodeReviewWorkflowRepository extends ServiceMap.Service<
  ProjectionCodeReviewWorkflowRepository,
  ProjectionCodeReviewWorkflowRepositoryShape
>()(
  "t3/persistence/Services/ProjectionCodeReviewWorkflows/ProjectionCodeReviewWorkflowRepository",
) {}
