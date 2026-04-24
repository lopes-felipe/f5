import {
  IsoDateTime,
  ProjectId,
  ProjectSkill,
  ProjectSkillScope,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProjectSkill = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  scope: ProjectSkillScope,
  commandName: TrimmedNonEmptyString,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  description: TrimmedNonEmptyString,
  argumentHint: Schema.NullOr(TrimmedNonEmptyString),
  allowedTools: ProjectSkill.fields.allowedTools,
  paths: ProjectSkill.fields.paths,
  updatedAt: IsoDateTime,
});
export type ProjectionProjectSkill = typeof ProjectionProjectSkill.Type;

export const ReplaceProjectionProjectSkillsInput = Schema.Struct({
  projectId: ProjectId,
  skills: Schema.Array(ProjectionProjectSkill),
});
export type ReplaceProjectionProjectSkillsInput = typeof ReplaceProjectionProjectSkillsInput.Type;

export const DeleteProjectionProjectSkillsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectSkillsByProjectInput =
  typeof DeleteProjectionProjectSkillsByProjectInput.Type;

export const ListProjectionProjectSkillsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionProjectSkillsByProjectInput =
  typeof ListProjectionProjectSkillsByProjectInput.Type;

export interface ProjectionProjectSkillRepositoryShape {
  readonly replaceForProject: (
    input: ReplaceProjectionProjectSkillsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByProjectId: (
    input: DeleteProjectionProjectSkillsByProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProjectSkill>,
    ProjectionRepositoryError
  >;
  readonly listByProjectId: (
    input: ListProjectionProjectSkillsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionProjectSkill>, ProjectionRepositoryError>;
}

export class ProjectionProjectSkillRepository extends ServiceMap.Service<
  ProjectionProjectSkillRepository,
  ProjectionProjectSkillRepositoryShape
>()("t3/persistence/Services/ProjectionProjectSkills/ProjectionProjectSkillRepository") {}
