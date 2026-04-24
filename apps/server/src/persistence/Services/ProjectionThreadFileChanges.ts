import {
  NonNegativeInt,
  OrchestrationFileChange,
  OrchestrationFileChangeId,
  OrchestrationFileChangeSummary,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadFileChange = OrchestrationFileChange;
export type ProjectionThreadFileChange = typeof ProjectionThreadFileChange.Type;

export const ProjectionThreadFileChangeSummary = OrchestrationFileChangeSummary;
export type ProjectionThreadFileChangeSummary = typeof ProjectionThreadFileChangeSummary.Type;

export const GetProjectionThreadFileChangeByIdInput = Schema.Struct({
  threadId: ThreadId,
  fileChangeId: OrchestrationFileChangeId,
});
export type GetProjectionThreadFileChangeByIdInput =
  typeof GetProjectionThreadFileChangeByIdInput.Type;

export const ListProjectionThreadFileChangesByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadFileChangesByThreadInput =
  typeof ListProjectionThreadFileChangesByThreadInput.Type;

export const ListProjectionThreadFileChangesByThreadAfterSequenceInput = Schema.Struct({
  threadId: ThreadId,
  afterSequenceExclusive: NonNegativeInt,
});
export type ListProjectionThreadFileChangesByThreadAfterSequenceInput =
  typeof ListProjectionThreadFileChangesByThreadAfterSequenceInput.Type;

export const GetProjectionThreadFileChangesLatestSequenceInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadFileChangesLatestSequenceInput =
  typeof GetProjectionThreadFileChangesLatestSequenceInput.Type;

export const DeleteProjectionThreadFileChangesByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadFileChangesByThreadInput =
  typeof DeleteProjectionThreadFileChangesByThreadInput.Type;

export const DeleteProjectionThreadFileChangesByTurnsInput = Schema.Struct({
  threadId: ThreadId,
  turnIds: Schema.Array(TurnId),
});
export type DeleteProjectionThreadFileChangesByTurnsInput =
  typeof DeleteProjectionThreadFileChangesByTurnsInput.Type;

export interface ProjectionThreadFileChangeRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadFileChange,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionThreadFileChangeByIdInput,
  ) => Effect.Effect<ProjectionThreadFileChange | null, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadFileChangesByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadFileChangeSummary>, ProjectionRepositoryError>;
  readonly listByThreadIdAfterSequence: (
    input: ListProjectionThreadFileChangesByThreadAfterSequenceInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadFileChangeSummary>, ProjectionRepositoryError>;
  readonly getLatestSequenceByThreadId: (
    input: GetProjectionThreadFileChangesLatestSequenceInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadFileChangesByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadIdAndTurnIds: (
    input: DeleteProjectionThreadFileChangesByTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadFileChangeRepository extends ServiceMap.Service<
  ProjectionThreadFileChangeRepository,
  ProjectionThreadFileChangeRepositoryShape
>()("t3/persistence/Services/ProjectionThreadFileChanges/ProjectionThreadFileChangeRepository") {}
