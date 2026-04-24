import {
  IsoDateTime,
  ProjectId,
  ProjectMemory,
  ProjectMemoryScope,
  ProjectMemoryType,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProjectMemory = Schema.Struct({
  memoryId: ProjectMemory.fields.id,
  projectId: ProjectId,
  scope: ProjectMemoryScope,
  type: ProjectMemoryType,
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProjectMemory = typeof ProjectionProjectMemory.Type;

export const GetProjectionProjectMemoryInput = Schema.Struct({
  memoryId: ProjectMemory.fields.id,
});
export type GetProjectionProjectMemoryInput = typeof GetProjectionProjectMemoryInput.Type;

export const ListProjectionProjectMemoriesByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionProjectMemoriesByProjectInput =
  typeof ListProjectionProjectMemoriesByProjectInput.Type;

export interface ProjectionProjectMemoryRepositoryShape {
  readonly upsert: (row: ProjectionProjectMemory) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionProjectMemoryInput,
  ) => Effect.Effect<Option.Option<ProjectionProjectMemory>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProjectMemory>,
    ProjectionRepositoryError
  >;
  readonly listByProjectId: (
    input: ListProjectionProjectMemoriesByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionProjectMemory>, ProjectionRepositoryError>;
}

export class ProjectionProjectMemoryRepository extends ServiceMap.Service<
  ProjectionProjectMemoryRepository,
  ProjectionProjectMemoryRepositoryShape
>()("t3/persistence/Services/ProjectionProjectMemories/ProjectionProjectMemoryRepository") {}
