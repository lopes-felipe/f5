import {
  IsoDateTime,
  McpConfigScope,
  McpProjectServersConfig,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectMcpConfigRecord = Schema.Struct({
  scope: McpConfigScope,
  projectName: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(() => null)),
  version: TrimmedNonEmptyString,
  servers: McpProjectServersConfig,
  disabledCommonServers: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: IsoDateTime,
});
export type ProjectMcpConfigRecord = typeof ProjectMcpConfigRecord.Type;

export const GetProjectMcpConfigInput = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(() => null)),
});
export type GetProjectMcpConfigInput = typeof GetProjectMcpConfigInput.Type;

export const ReplaceProjectMcpConfigInput = Schema.Struct({
  scope: McpConfigScope,
  projectId: Schema.NullOr(ProjectId).pipe(Schema.withDecodingDefault(() => null)),
  expectedVersion: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  nextVersion: TrimmedNonEmptyString,
  servers: McpProjectServersConfig,
  disabledCommonServers: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: IsoDateTime,
});
export type ReplaceProjectMcpConfigInput = typeof ReplaceProjectMcpConfigInput.Type;

export interface ProjectMcpConfigRepositoryShape {
  readonly listByScope: (
    scope: "common" | "project",
    options?: { readonly includeDeleted?: boolean },
  ) => Effect.Effect<ReadonlyArray<ProjectMcpConfigRecord>, ProjectionRepositoryError>;
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectionRepositoryError, R>;

  readonly get: (
    input: GetProjectMcpConfigInput,
  ) => Effect.Effect<Option.Option<ProjectMcpConfigRecord>, ProjectionRepositoryError>;
  readonly replaceIfVersionMatches: (
    input: ReplaceProjectMcpConfigInput,
  ) => Effect.Effect<Option.Option<ProjectMcpConfigRecord>, ProjectionRepositoryError>;
}

export class ProjectMcpConfigRepository extends ServiceMap.Service<
  ProjectMcpConfigRepository,
  ProjectMcpConfigRepositoryShape
>()("t3/persistence/Services/ProjectMcpConfigs/ProjectMcpConfigRepository") {}
