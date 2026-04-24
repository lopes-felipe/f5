import {
  type CodexMcpServerEntry,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpProjectConfigResult,
  McpProjectServersConfig,
  type McpReplaceCommonConfigRequest,
  type McpReplaceProjectConfigRequest,
  ProjectId,
} from "@t3tools/contracts";
import { computeEffectiveMcpConfigVersion, mergeMcpServerLayers } from "@t3tools/shared/mcpConfig";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";
import { Effect, Layer, Option, Schema, ServiceMap } from "effect";

import {
  ProjectMcpConfigRepository,
  type ProjectMcpConfigRecord,
} from "../persistence/Services/ProjectMcpConfigs.ts";

export interface StoredCommonMcpConfig {
  readonly scope: "common";
  readonly version?: string;
  readonly servers: McpProjectServersConfig;
}

export interface StoredProjectMcpConfig {
  readonly scope: "project";
  readonly projectId: ProjectId;
  readonly version?: string;
  readonly servers: McpProjectServersConfig;
}

export interface StoredEffectiveMcpConfig {
  readonly projectId: ProjectId;
  readonly commonVersion?: string;
  readonly projectVersion?: string;
  readonly effectiveVersion: string;
  readonly servers: McpProjectServersConfig;
}

type ReplaceCommonMcpConfigInput = McpReplaceCommonConfigRequest;
type ReplaceProjectMcpConfigInput = McpReplaceProjectConfigRequest;

export class ProjectMcpConfigServiceError extends Schema.TaggedErrorClass<ProjectMcpConfigServiceError>()(
  "ProjectMcpConfigServiceError",
  {
    code: Schema.Literals(["conflict", "validation", "storage"]),
    message: Schema.String,
  },
) {}

export interface ProjectMcpConfigServiceShape {
  readonly readCommonStoredConfig: () => Effect.Effect<
    StoredCommonMcpConfig,
    ProjectMcpConfigServiceError
  >;
  readonly readProjectStoredConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<StoredProjectMcpConfig, ProjectMcpConfigServiceError>;
  readonly readEffectiveStoredConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<StoredEffectiveMcpConfig, ProjectMcpConfigServiceError>;
  readonly readCommonConfig: () => Effect.Effect<
    McpCommonConfigResult,
    ProjectMcpConfigServiceError
  >;
  readonly replaceCommonConfig: (
    input: ReplaceCommonMcpConfigInput,
  ) => Effect.Effect<McpCommonConfigResult, ProjectMcpConfigServiceError>;
  readonly readProjectConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<McpProjectConfigResult, ProjectMcpConfigServiceError>;
  readonly replaceProjectConfig: (
    input: ReplaceProjectMcpConfigInput,
  ) => Effect.Effect<McpProjectConfigResult, ProjectMcpConfigServiceError>;
  readonly readEffectiveConfig: (
    projectId: ProjectId,
  ) => Effect.Effect<McpEffectiveConfigResult, ProjectMcpConfigServiceError>;
  readonly readCodexServers: (projectId: ProjectId) => Effect.Effect<
    {
      readonly projectId: ProjectId;
      readonly effectiveVersion: string;
      readonly servers: Record<string, CodexMcpServerEntry>;
    },
    ProjectMcpConfigServiceError
  >;
}

export class ProjectMcpConfigService extends ServiceMap.Service<
  ProjectMcpConfigService,
  ProjectMcpConfigServiceShape
>()("t3/mcp/ProjectMcpConfigService") {}

function rowToStoredCommonConfig(row: ProjectMcpConfigRecord | undefined): StoredCommonMcpConfig {
  return {
    scope: "common",
    ...(row?.version ? { version: row.version } : {}),
    servers: row?.servers ?? {},
  };
}

function rowToStoredProjectConfig(
  projectId: ProjectId,
  row: ProjectMcpConfigRecord | undefined,
): StoredProjectMcpConfig {
  return {
    scope: "project",
    projectId,
    ...(row?.version ? { version: row.version } : {}),
    servers: row?.servers ?? {},
  };
}

const makeProjectMcpConfigService = Effect.gen(function* () {
  const repository = yield* ProjectMcpConfigRepository;

  const toStorageError = (operation: string) => (cause: unknown) =>
    new ProjectMcpConfigServiceError({
      code: "storage",
      message:
        cause instanceof Error
          ? `${operation}: ${cause.message}`
          : `${operation}: failed to access persisted MCP config.`,
    });

  const readCommonStoredConfig: ProjectMcpConfigServiceShape["readCommonStoredConfig"] = () =>
    repository.get({ scope: "common", projectId: null }).pipe(
      Effect.mapError(toStorageError("Failed to read common MCP config")),
      Effect.map((rowOption) => rowToStoredCommonConfig(Option.getOrUndefined(rowOption))),
    );

  const readProjectStoredConfig: ProjectMcpConfigServiceShape["readProjectStoredConfig"] = (
    projectId,
  ) =>
    repository.get({ scope: "project", projectId }).pipe(
      Effect.mapError(toStorageError("Failed to read project MCP config")),
      Effect.map((rowOption) =>
        rowToStoredProjectConfig(projectId, Option.getOrUndefined(rowOption)),
      ),
    );

  const readEffectiveStoredConfig: ProjectMcpConfigServiceShape["readEffectiveStoredConfig"] = (
    projectId,
  ) =>
    Effect.gen(function* () {
      const [commonConfig, projectConfig] = yield* Effect.all([
        readCommonStoredConfig(),
        readProjectStoredConfig(projectId),
      ]);
      const servers = mergeMcpServerLayers({
        common: commonConfig.servers,
        project: projectConfig.servers,
      });
      return {
        projectId,
        ...(commonConfig.version ? { commonVersion: commonConfig.version } : {}),
        ...(projectConfig.version ? { projectVersion: projectConfig.version } : {}),
        effectiveVersion: computeEffectiveMcpConfigVersion(servers),
        servers,
      };
    });

  const readCommonConfig: ProjectMcpConfigServiceShape["readCommonConfig"] = () =>
    readCommonStoredConfig().pipe(
      Effect.map((stored) => ({
        ...(stored.version ? { version: stored.version } : {}),
        servers: stored.servers,
      })),
    );

  const replaceCommonConfig: ProjectMcpConfigServiceShape["replaceCommonConfig"] = (input) =>
    Effect.gen(function* () {
      const version = crypto.randomUUID();
      const updatedAt = new Date().toISOString();
      const saved = yield* repository
        .replaceIfVersionMatches({
          scope: "common",
          projectId: null,
          expectedVersion: input.expectedVersion ?? null,
          nextVersion: version,
          servers: input.servers,
          updatedAt,
        })
        .pipe(Effect.mapError(toStorageError("Failed to save common MCP config")));

      if (Option.isNone(saved)) {
        return yield* new ProjectMcpConfigServiceError({
          code: "conflict",
          message: "MCP configuration changed since this page loaded. Refresh and try again.",
        });
      }

      return {
        version,
        servers: saved.value.servers,
      };
    });

  const readProjectConfig: ProjectMcpConfigServiceShape["readProjectConfig"] = (projectId) =>
    readProjectStoredConfig(projectId).pipe(
      Effect.map((stored) => ({
        projectId,
        ...(stored.version ? { version: stored.version } : {}),
        servers: stored.servers,
      })),
    );

  const replaceProjectConfig: ProjectMcpConfigServiceShape["replaceProjectConfig"] = (input) =>
    Effect.gen(function* () {
      const version = crypto.randomUUID();
      const updatedAt = new Date().toISOString();
      const saved = yield* repository
        .replaceIfVersionMatches({
          scope: "project",
          projectId: input.projectId,
          expectedVersion: input.expectedVersion ?? null,
          nextVersion: version,
          servers: input.servers,
          updatedAt,
        })
        .pipe(Effect.mapError(toStorageError("Failed to save project MCP config")));

      if (Option.isNone(saved)) {
        return yield* new ProjectMcpConfigServiceError({
          code: "conflict",
          message: "MCP configuration changed since this page loaded. Refresh and try again.",
        });
      }

      return {
        projectId: input.projectId,
        version,
        servers: saved.value.servers,
      };
    });

  const readEffectiveConfig: ProjectMcpConfigServiceShape["readEffectiveConfig"] = (projectId) =>
    readEffectiveStoredConfig(projectId).pipe(
      Effect.map((stored) => ({
        projectId,
        ...(stored.commonVersion ? { commonVersion: stored.commonVersion } : {}),
        ...(stored.projectVersion ? { projectVersion: stored.projectVersion } : {}),
        effectiveVersion: stored.effectiveVersion,
        servers: stored.servers,
      })),
    );

  const readCodexServers: ProjectMcpConfigServiceShape["readCodexServers"] = (projectId) =>
    readEffectiveStoredConfig(projectId).pipe(
      Effect.map((stored) => ({
        projectId,
        effectiveVersion: stored.effectiveVersion,
        servers: translateMcpForCodex(stored.servers) ?? {},
      })),
    );

  return {
    readCommonStoredConfig,
    readProjectStoredConfig,
    readEffectiveStoredConfig,
    readCommonConfig,
    replaceCommonConfig,
    readProjectConfig,
    replaceProjectConfig,
    readEffectiveConfig,
    readCodexServers,
  } satisfies ProjectMcpConfigServiceShape;
});

export const ProjectMcpConfigServiceLive = Layer.effect(
  ProjectMcpConfigService,
  makeProjectMcpConfigService,
);
