import {
  NonNegativeInt,
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionSummary,
  OrchestrationCommandExecutionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadCommandExecution = OrchestrationCommandExecution;
export type ProjectionThreadCommandExecution = typeof ProjectionThreadCommandExecution.Type;

export const ProjectionThreadCommandExecutionSummary = OrchestrationCommandExecutionSummary;
export type ProjectionThreadCommandExecutionSummary =
  typeof ProjectionThreadCommandExecutionSummary.Type;

export const GetProjectionThreadCommandExecutionByIdInput = Schema.Struct({
  commandExecutionId: OrchestrationCommandExecutionId,
});
export type GetProjectionThreadCommandExecutionByIdInput =
  typeof GetProjectionThreadCommandExecutionByIdInput.Type;

export const ListProjectionThreadCommandExecutionsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadCommandExecutionsByThreadInput =
  typeof ListProjectionThreadCommandExecutionsByThreadInput.Type;

export const ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput = Schema.Struct({
  threadId: ThreadId,
  afterSequenceExclusive: NonNegativeInt,
});
export type ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput =
  typeof ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput.Type;

export const GetProjectionThreadCommandExecutionsLatestSequenceInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadCommandExecutionsLatestSequenceInput =
  typeof GetProjectionThreadCommandExecutionsLatestSequenceInput.Type;

export const DeleteProjectionThreadCommandExecutionsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadCommandExecutionsByThreadInput =
  typeof DeleteProjectionThreadCommandExecutionsByThreadInput.Type;

export const DeleteProjectionThreadCommandExecutionsByTurnsInput = Schema.Struct({
  threadId: ThreadId,
  turnIds: Schema.Array(TurnId),
});
export type DeleteProjectionThreadCommandExecutionsByTurnsInput =
  typeof DeleteProjectionThreadCommandExecutionsByTurnsInput.Type;

export interface ProjectionThreadCommandExecutionRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadCommandExecution,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadCommandExecutionByIdInput,
  ) => Effect.Effect<ProjectionThreadCommandExecution | null, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadCommandExecutionsByThreadInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadCommandExecutionSummary>,
    ProjectionRepositoryError
  >;
  readonly listByThreadIdAfterSequence: (
    input: ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionThreadCommandExecutionSummary>,
    ProjectionRepositoryError
  >;
  readonly getLatestSequenceByThreadId: (
    input: GetProjectionThreadCommandExecutionsLatestSequenceInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadCommandExecutionsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadIdAndTurnIds: (
    input: DeleteProjectionThreadCommandExecutionsByTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadCommandExecutionRepository extends ServiceMap.Service<
  ProjectionThreadCommandExecutionRepository,
  ProjectionThreadCommandExecutionRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadCommandExecutions/ProjectionThreadCommandExecutionRepository",
) {}
