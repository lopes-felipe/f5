import {
  MCP_APPS_WS_METHODS,
  McpServerWriteDefinition,
  type ProviderInstanceId,
  type ProviderKind,
  WS_METHODS,
} from "@t3tools/contracts";
import { Effect, Schema, Struct } from "effect";

import type { ServerSecretStoreShape } from "../../auth/Services/ServerSecretStore.ts";
import type { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import type { makeMcpAccountExecutionResolver } from "../../mcp/accountExecution.ts";
import { detectMcpImports } from "../../mcp/McpImportDetection.ts";
import { probeMcpServer } from "../../mcp/McpProbe.ts";
import type { McpRuntimeService } from "../../mcp/McpRuntimeService.ts";
import { resolveMcpSecrets } from "../../mcp/McpSecretResolver.ts";
import type { makeMcpSecretWriter } from "../../mcp/McpSecretWriter.ts";
import type { ProjectMcpConfigService } from "../../mcp/ProjectMcpConfigService.ts";
import type { McpAppService } from "../../mcpApps/McpAppService.ts";
import type { ProviderCommandReactorShape } from "../../orchestration/Services/ProviderCommandReactor.ts";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { routePromise, type RouteTable } from "./routeTable.ts";

type McpMethod =
  | typeof WS_METHODS.mcpGetProjectConfig
  | typeof WS_METHODS.mcpGetCommonConfig
  | typeof WS_METHODS.mcpReplaceProjectConfig
  | typeof WS_METHODS.mcpReplaceCommonConfig
  | typeof WS_METHODS.mcpGetEffectiveConfig
  | typeof WS_METHODS.mcpGetProviderStatus
  | typeof WS_METHODS.mcpGetServerStatuses
  | typeof WS_METHODS.mcpListImportCandidates
  | typeof WS_METHODS.mcpProbeServer
  | typeof WS_METHODS.mcpStoreSecret
  | typeof WS_METHODS.mcpInspectServer
  | typeof WS_METHODS.mcpReconnectServer
  | typeof WS_METHODS.mcpStartLogin
  | typeof WS_METHODS.mcpGetLoginStatus
  | typeof WS_METHODS.mcpApplyToLiveSessions
  | typeof MCP_APPS_WS_METHODS.toolInfo
  | typeof MCP_APPS_WS_METHODS.callTool
  | typeof MCP_APPS_WS_METHODS.readResource
  | typeof MCP_APPS_WS_METHODS.updateModelContext;

export interface McpRouteDependencies {
  readonly projectMcpConfigService: typeof ProjectMcpConfigService.Service;
  readonly mcpRuntimeService: typeof McpRuntimeService.Service;
  readonly codexMcpEventBus: typeof CodexMcpEventBus.Service;
  readonly providerService: typeof ProviderService.Service;
  readonly profileSecrets: ServerSecretStoreShape;
  readonly storeMcpSecret: Effect.Success<ReturnType<typeof makeMcpSecretWriter>>;
  readonly resolveMcpFeatureExecution: Effect.Success<typeof makeMcpAccountExecutionResolver>;
  readonly resolveMcpAccount: <
    T extends {
      binaryPath?: string | undefined;
      homePath?: string | undefined;
      instanceId?: ProviderInstanceId | undefined;
      provider?: string | undefined;
    },
  >(
    body: T,
  ) => Promise<T & { provider: ProviderKind; instanceId: ProviderInstanceId }>;
  readonly runtime: Effect.Effect<
    {
      readonly providerCommandReactor: ProviderCommandReactorShape;
      readonly mcpApps: typeof McpAppService.Service;
    },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * MCP configuration, status, discovery, probing, secret storage, OAuth/login,
 * live session reload, and MCP Apps routes.
 */
export const mcpRoutes = ({
  projectMcpConfigService,
  mcpRuntimeService,
  codexMcpEventBus,
  providerService,
  profileSecrets,
  storeMcpSecret,
  resolveMcpFeatureExecution,
  resolveMcpAccount,
  runtime,
}: McpRouteDependencies): RouteTable<McpMethod, never, Error> => ({
  [WS_METHODS.mcpGetProjectConfig]: (request) =>
    projectMcpConfigService
      .readProjectConfig(request.projectId)
      .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

  [WS_METHODS.mcpGetCommonConfig]: () =>
    projectMcpConfigService
      .readCommonConfig()
      .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

  [WS_METHODS.mcpReplaceProjectConfig]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const result = yield* projectMcpConfigService
        .replaceProjectConfig(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      yield* codexMcpEventBus.publishStatusUpdated({
        scope: "project",
        projectId: body.projectId,
        reason: "updated",
        ...(result.version ? { configVersion: result.version } : {}),
      });
      return result;
    }),

  [WS_METHODS.mcpReplaceCommonConfig]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const result = yield* projectMcpConfigService
        .replaceCommonConfig(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      yield* codexMcpEventBus.publishStatusUpdated({
        scope: "common",
        reason: "updated",
        ...(result.version ? { configVersion: result.version } : {}),
      });
      return result;
    }),

  [WS_METHODS.mcpGetEffectiveConfig]: (request) =>
    projectMcpConfigService
      .readEffectiveConfig(request.projectId)
      .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

  [WS_METHODS.mcpGetProviderStatus]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      return yield* mcpRuntimeService
        .getProviderStatus(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.mcpGetServerStatuses]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      return yield* mcpRuntimeService
        .getServerStatuses(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.mcpListImportCandidates]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      const execution = yield* resolveMcpFeatureExecution(body).pipe(
        Effect.mapError((error) => new RouteRequestError({ message: error.message })),
      );
      return yield* routePromise(() =>
        detectMcpImports({
          environment: execution.environment,
          ...(body.projectId ? { cwd: execution.cwd } : {}),
        }),
      );
    }),

  [WS_METHODS.mcpProbeServer]: (request) =>
    Effect.gen(function* () {
      const requestBody = withoutTag(request);
      if (!Schema.is(McpServerWriteDefinition)(requestBody.server)) {
        return yield* new RouteRequestError({
          message: "Invalid MCP draft. Check the command, HTTP URL, and options.",
        });
      }
      const body = yield* routePromise(() => resolveMcpAccount(requestBody));
      const execution = yield* resolveMcpFeatureExecution(body).pipe(
        Effect.mapError((error) => new RouteRequestError({ message: error.message })),
      );
      const resolved = yield* resolveMcpSecrets({ [body.serverName]: body.server }, profileSecrets);
      const server = resolved.servers[body.serverName];
      if (!server) {
        return {
          ok: false,
          durationMs: 0,
          tools: [],
          toolsTruncated: false,
          resourceCount: 0,
          promptCount: 0,
          authRequired: false,
          error: resolved.issues[0]?.message ?? "Stored secret is unavailable.",
        };
      }
      return yield* probeMcpServer({ ...body, server }, execution);
    }),

  [WS_METHODS.mcpStoreSecret]: (request) =>
    storeMcpSecret(request.value).pipe(
      Effect.mapError((error) => new RouteRequestError({ message: error.message })),
    ),

  [WS_METHODS.mcpInspectServer]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      return yield* mcpRuntimeService
        .inspectServer(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.mcpReconnectServer]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      const targetResult =
        body.provider === "codex" && providerService.getMcpReconnectTargets
          ? yield* providerService
              .getMcpReconnectTargets(body)
              .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })))
          : { threadIds: [], failures: [] };
      const targets = targetResult.threadIds;
      const result = yield* mcpRuntimeService
        .reconnectServer(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      if (body.provider === "claudeAgent") return result;
      if (targets.length === 0) {
        return yield* mcpRuntimeService
          .sanitizeReconnectResult(body, {
            ...result,
            failures: [...result.failures, ...targetResult.failures],
          })
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      }
      const { providerCommandReactor } = yield* runtime;
      const applied = yield* providerCommandReactor
        .applyMcpConfigToLiveSessions({
          scope: "project",
          projectId: body.projectId,
          instanceId: body.instanceId,
          threadIds: targets,
          retryUnchanged: true,
        })
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      yield* codexMcpEventBus.publishStatusUpdated({
        scope: "project",
        projectId: body.projectId,
        ...(body.instanceId ? { instanceId: body.instanceId } : {}),
        reason: "reloaded",
      });
      const sessions = applied.sessions ?? [];
      return yield* mcpRuntimeService
        .sanitizeReconnectResult(body, {
          ...result,
          sessionsMatched: targets.length,
          sessionsReconnected: sessions.filter((session) => session.disposition === "applied")
            .length,
          sessions,
          failures: [
            ...result.failures,
            ...targetResult.failures,
            ...sessions
              .filter((session) => session.disposition !== "applied")
              .map((session) => ({
                threadId: session.threadId,
                message:
                  session.result.errors.map((error) => error.message).join("; ") ||
                  session.disposition,
              })),
          ],
        })
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.mcpStartLogin]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      return yield* mcpRuntimeService
        .startLogin(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
    }),

  [WS_METHODS.mcpGetLoginStatus]: (request) =>
    Effect.gen(function* () {
      const body = yield* routePromise(() => resolveMcpAccount(withoutTag(request)));
      return yield* mcpRuntimeService.getLoginStatus(body);
    }),

  [WS_METHODS.mcpApplyToLiveSessions]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const { providerCommandReactor } = yield* runtime;
      const result = yield* providerCommandReactor
        .applyMcpConfigToLiveSessions(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      yield* codexMcpEventBus.publishStatusUpdated({
        scope: result.scope,
        ...(body.instanceId ? { instanceId: body.instanceId } : {}),
        ...(result.projectId ? { projectId: result.projectId } : {}),
        reason: "applied",
        ...(result.configVersion ? { configVersion: result.configVersion } : {}),
      });
      return result;
    }),

  [MCP_APPS_WS_METHODS.toolInfo]: (request) =>
    Effect.flatMap(runtime, ({ mcpApps }) => mcpApps.toolInfo(withoutTag(request))),
  [MCP_APPS_WS_METHODS.callTool]: (request) =>
    Effect.flatMap(runtime, ({ mcpApps }) => mcpApps.callTool(withoutTag(request))),
  [MCP_APPS_WS_METHODS.readResource]: (request) =>
    Effect.flatMap(runtime, ({ mcpApps }) => mcpApps.readResource(withoutTag(request))),
  [MCP_APPS_WS_METHODS.updateModelContext]: (request) =>
    Effect.flatMap(runtime, ({ mcpApps }) => mcpApps.updateModelContext(withoutTag(request))),
});
