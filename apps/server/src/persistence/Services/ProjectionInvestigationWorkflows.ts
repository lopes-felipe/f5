import {
  InvestigationWorkflow,
  InvestigationWorkflowId,
  IsoDateTime,
  ProjectId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionInvestigationWorkflow = InvestigationWorkflow;
export type ProjectionInvestigationWorkflow = typeof ProjectionInvestigationWorkflow.Type;

export const GetProjectionInvestigationWorkflowInput = Schema.Struct({
  workflowId: InvestigationWorkflowId,
});
export type GetProjectionInvestigationWorkflowInput =
  typeof GetProjectionInvestigationWorkflowInput.Type;

export const ListProjectionInvestigationWorkflowsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionInvestigationWorkflowsByProjectInput =
  typeof ListProjectionInvestigationWorkflowsByProjectInput.Type;

export const DeleteProjectionInvestigationWorkflowInput = Schema.Struct({
  workflowId: InvestigationWorkflowId,
  deletedAt: IsoDateTime,
});
export type DeleteProjectionInvestigationWorkflowInput =
  typeof DeleteProjectionInvestigationWorkflowInput.Type;

export interface ProjectionInvestigationWorkflowRepositoryShape {
  readonly upsert: (
    workflow: ProjectionInvestigationWorkflow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionInvestigationWorkflowInput,
  ) => Effect.Effect<Option.Option<ProjectionInvestigationWorkflow>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionInvestigationWorkflowsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionInvestigationWorkflow>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionInvestigationWorkflow>,
    ProjectionRepositoryError
  >;
  readonly deleteById: (
    input: DeleteProjectionInvestigationWorkflowInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionInvestigationWorkflowRepository extends ServiceMap.Service<
  ProjectionInvestigationWorkflowRepository,
  ProjectionInvestigationWorkflowRepositoryShape
>()(
  "t3/persistence/Services/ProjectionInvestigationWorkflows/ProjectionInvestigationWorkflowRepository",
) {}
