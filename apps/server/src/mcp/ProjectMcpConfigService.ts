import {
  type CodexMcpServerEntry,
  type McpConfigIssue,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpProjectConfigResult,
  McpProjectServersConfig,
  type McpReplaceCommonConfigRequest,
  type McpReplaceProjectConfigRequest,
  ProjectId,
} from "@t3tools/contracts";
import {
  assertMcpRuntimeConfig,
  readMcpValidationIssues,
  readMcpLayerNameConflicts,
  validateMcpLayerWrite,
  validateMcpLayerMerge,
} from "@t3tools/shared/mcpValidation";
import { computeEffectiveMcpConfigVersion, mergeMcpServerLayers } from "@t3tools/shared/mcpConfig";
import {
  readCodexMcpOAuthCallbackConfig,
  translateMcpForCodex,
} from "@t3tools/shared/mcpTranslation";
import { Effect, Layer, Option, Schema, Semaphore, ServiceMap } from "effect";

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
  readonly projectName?: string;
  readonly projectId: ProjectId;
  readonly version?: string;
  readonly servers: McpProjectServersConfig;
}

export interface StoredEffectiveMcpConfig {
  readonly issues?: ReadonlyArray<McpConfigIssue>;
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

function readCodexMcpOAuthCallbackConfigOrError(servers: McpProjectServersConfig): Effect.Effect<
  {
    readonly port?: number;
    readonly url?: string;
  },
  ProjectMcpConfigServiceError
> {
  return Effect.try({
    try: () => {
      assertMcpRuntimeConfig(servers);
      return readCodexMcpOAuthCallbackConfig(servers);
    },
    catch: (cause) =>
      new ProjectMcpConfigServiceError({
        code: "validation",
        message:
          cause instanceof Error
            ? cause.message
            : "Invalid Codex MCP OAuth callback configuration.",
      }),
  });
}

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
      readonly oauthCallbackPort?: number;
      readonly oauthCallbackUrl?: string;
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
    ...(row?.projectName ? { projectName: row.projectName } : {}),
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

  const writeLock = yield* Semaphore.make(1);
  const validationError = (cause: unknown) =>
    new ProjectMcpConfigServiceError({
      code: "validation",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const listProjects = () =>
    repository
      .listByScope("project")
      .pipe(Effect.mapError(toStorageError("Failed to list project MCP configs")));
  const callbackIssue = (
    servers: McpProjectServersConfig,
    projectIds: ProjectId[],
    projectNames: ReadonlyArray<string> = projectIds,
  ): McpConfigIssue[] => {
    try {
      readCodexMcpOAuthCallbackConfig(servers);
      return [];
    } catch {
      return [
        {
          kind: "compatibility",
          projectIds,
          message:
            projectIds.length > 0
              ? `This change conflicts with the Codex OAuth callback port/URL configured in ${projectIds.length} project(s): ${projectNames.join(", ")}.`
              : "This configuration has conflicting Codex OAuth callback ports/URLs. Claude can still use it.",
        },
      ];
    }
  };
  const commonIssues = (servers: McpProjectServersConfig) =>
    Effect.gen(function* () {
      const projects = yield* listProjects();
      const affectedRows = projects.filter(
        (row) =>
          callbackIssue(mergeMcpServerLayers({ common: servers, project: row.servers }), [])
            .length > 0,
      );
      const affected = affectedRows.flatMap((row) => (row.projectId ? [row.projectId] : []));
      const affectedNames = affectedRows.flatMap((row) =>
        row.projectId ? [row.projectName ?? row.projectId] : [],
      );
      return [
        ...readMcpValidationIssues(servers),
        ...projects.flatMap((row) =>
          readMcpLayerNameConflicts(servers, row.servers).map((issue) => ({
            ...issue,
            projectIds: row.projectId ? [row.projectId] : [],
          })),
        ),
        ...callbackIssue(servers, []),
        ...(affected.length > 0
          ? [
              {
                kind: "compatibility" as const,
                projectIds: affected,
                message: `This change conflicts with the Codex OAuth callback port/URL configured in ${affected.length} project(s): ${affectedNames.join(", ")}.`,
              },
            ]
          : []),
      ];
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
    writeLock.withPermits(1)(
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
          issues: [
            ...readMcpValidationIssues(commonConfig.servers),
            ...readMcpValidationIssues(projectConfig.servers),
            ...readMcpLayerNameConflicts(commonConfig.servers, projectConfig.servers),
            ...callbackIssue(servers, [projectId], [projectConfig.projectName ?? projectId]),
          ],
        };
      }),
    );

  const readCommonConfig: ProjectMcpConfigServiceShape["readCommonConfig"] = () =>
    Effect.gen(function* () {
      const stored = yield* readCommonStoredConfig();
      return {
        ...(stored.version ? { version: stored.version } : {}),
        servers: stored.servers,
        issues: yield* commonIssues(stored.servers),
      };
    });

  const readProjectConfig: ProjectMcpConfigServiceShape["readProjectConfig"] = (projectId) =>
    Effect.gen(function* () {
      const stored = yield* readProjectStoredConfig(projectId);
      const common = yield* readCommonStoredConfig();
      const merged = mergeMcpServerLayers({ common: common.servers, project: stored.servers });
      return {
        projectId,
        ...(stored.version ? { version: stored.version } : {}),
        servers: stored.servers,
        issues: [
          ...readMcpValidationIssues(stored.servers),
          ...readMcpLayerNameConflicts(common.servers, stored.servers),
          ...callbackIssue(merged, [projectId], [stored.projectName ?? projectId]),
        ],
      };
    });

  const replace = (input: ReplaceCommonMcpConfigInput | ReplaceProjectMcpConfigInput) =>
    writeLock.withPermits(1)(
      repository
        .withTransaction(
          Effect.gen(function* () {
            const projectId = "projectId" in input ? input.projectId : undefined;
            const base = projectId
              ? yield* readProjectStoredConfig(projectId)
              : yield* readCommonStoredConfig();
            if ((base.version ?? null) !== (input.expectedVersion ?? null))
              return yield* new ProjectMcpConfigServiceError({
                code: "conflict",
                message: "MCP configuration changed since this page loaded. Refresh and try again.",
              });
            const servers = yield* Effect.try({
              try: () => validateMcpLayerWrite(base.servers, input.servers),
              catch: validationError,
            });
            if (projectId) {
              const common = yield* readCommonStoredConfig();
              yield* Effect.try({
                try: () =>
                  validateMcpLayerMerge({
                    common: common.servers,
                    project: servers,
                    baseCommon: common.servers,
                    baseProject: base.servers,
                  }),
                catch: validationError,
              });
            } else {
              const projects = yield* listProjects();
              for (const row of projects)
                yield* Effect.try({
                  try: () =>
                    validateMcpLayerMerge({
                      common: servers,
                      project: row.servers,
                      baseCommon: base.servers,
                      baseProject: row.servers,
                    }),
                  catch: validationError,
                });
            }
            const saved = yield* repository
              .replaceIfVersionMatches({
                scope: projectId ? "project" : "common",
                projectId: projectId ?? null,
                expectedVersion: input.expectedVersion ?? null,
                nextVersion: crypto.randomUUID(),
                servers,
                updatedAt: new Date().toISOString(),
              })
              .pipe(Effect.mapError(toStorageError("Failed to save MCP config")));
            if (Option.isNone(saved))
              return yield* new ProjectMcpConfigServiceError({
                code: "conflict",
                message: "MCP configuration changed since this page loaded. Refresh and try again.",
              });
            return projectId ? yield* readProjectConfig(projectId) : yield* readCommonConfig();
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            Schema.is(ProjectMcpConfigServiceError)(error)
              ? error
              : toStorageError("Failed to save MCP config")(error),
          ),
        ),
    );
  const replaceCommonConfig: ProjectMcpConfigServiceShape["replaceCommonConfig"] = (input) =>
    replace(input);
  const replaceProjectConfig: ProjectMcpConfigServiceShape["replaceProjectConfig"] = (input) =>
    replace(input).pipe(Effect.map((result) => ({ ...result, projectId: input.projectId })));

  const readEffectiveConfig: ProjectMcpConfigServiceShape["readEffectiveConfig"] = (projectId) =>
    readEffectiveStoredConfig(projectId);

  const readCodexServers: ProjectMcpConfigServiceShape["readCodexServers"] = (projectId) =>
    readEffectiveStoredConfig(projectId).pipe(
      Effect.flatMap((stored) =>
        readCodexMcpOAuthCallbackConfigOrError(stored.servers).pipe(
          Effect.map((oauthCallbackConfig) => ({
            projectId,
            effectiveVersion: stored.effectiveVersion,
            servers: translateMcpForCodex(stored.servers) ?? {},
            ...(oauthCallbackConfig.port ? { oauthCallbackPort: oauthCallbackConfig.port } : {}),
            ...(oauthCallbackConfig.url ? { oauthCallbackUrl: oauthCallbackConfig.url } : {}),
          })),
        ),
      ),
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
