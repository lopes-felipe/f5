import {
  MCP_APPS_WS_METHODS,
  McpServerWriteDefinition,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderKind,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { Effect, Schema, Struct } from "effect";

import type { ServerSecretStoreShape } from "../../auth/Services/ServerSecretStore.ts";
import type { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import type { makeMcpAccountExecutionResolver } from "../../mcp/accountExecution.ts";
import { detectMcpImports } from "../../mcp/McpImportDetection.ts";
import type { McpHub } from "../../mcp/hub/McpHub.ts";
import type { McpHubAuth } from "../../mcp/hub/McpHubAuth.ts";
import type { McpHubGovernanceService } from "../../mcp/hub/McpHubGovernanceLive.ts";
import {
  flattenPrompt,
  listComposerPrompts,
  listComposerResources,
  shapeResourceContents,
} from "../../mcp/hub/mcpComposerContext.ts";
import type { McpCatalog } from "../../mcp/McpCatalog.ts";
import { probeMcpServer } from "../../mcp/McpProbe.ts";
import {
  type McpRepositoryLayer,
  type McpRepositoryServers,
  repositoryApprovalLimitIssue,
} from "../../mcp/McpRepositoryServers.ts";
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
  | typeof WS_METHODS.mcpGetHubStatus
  | typeof WS_METHODS.mcpReconnectHubServer
  | typeof WS_METHODS.mcpGetHubAuthStatus
  | typeof WS_METHODS.mcpStartHubSignIn
  | typeof WS_METHODS.mcpCompleteHubSignIn
  | typeof WS_METHODS.mcpSignOutHubServer
  | typeof WS_METHODS.mcpListToolPins
  | typeof WS_METHODS.mcpAcceptToolChanges
  | typeof WS_METHODS.mcpListActivity
  | typeof WS_METHODS.mcpGetThreadServers
  | typeof WS_METHODS.mcpSetThreadServerEnabled
  | typeof WS_METHODS.mcpListComposerPrompts
  | typeof WS_METHODS.mcpGetComposerPrompt
  | typeof WS_METHODS.mcpCompleteComposerPrompt
  | typeof WS_METHODS.mcpListComposerResources
  | typeof WS_METHODS.mcpReadComposerResource
  | typeof WS_METHODS.mcpSearchCatalog
  | typeof WS_METHODS.mcpGetRepositoryServers
  | typeof WS_METHODS.mcpSetRepositoryServerTrust
  | typeof WS_METHODS.mcpApplyToLiveSessions
  | typeof MCP_APPS_WS_METHODS.toolInfo
  | typeof MCP_APPS_WS_METHODS.callTool
  | typeof MCP_APPS_WS_METHODS.readResource
  | typeof MCP_APPS_WS_METHODS.updateModelContext;

export interface McpRouteDependencies {
  readonly projectMcpConfigService: typeof ProjectMcpConfigService.Service;
  readonly mcpRuntimeService: typeof McpRuntimeService.Service;
  readonly mcpHub: typeof McpHub.Service | undefined;
  readonly mcpHubAuth: typeof McpHubAuth.Service | undefined;
  readonly mcpHubGovernance: typeof McpHubGovernanceService.Service | undefined;
  readonly mcpRepositoryServers: typeof McpRepositoryServers.Service | undefined;
  /** Shared by every client of this server, so registry pages stay cached across them. */
  readonly mcpCatalog: McpCatalog;
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

/** The hub server a conversation's live session uses under `serverName`, for the composer. */
const composerServer = (
  mcpHub: typeof McpHub.Service | undefined,
  threadId: ThreadId,
  serverName: string,
) => {
  const server = mcpHub?.sessionServers?.(threadId).get(serverName);
  return server
    ? Effect.succeed(server)
    : Effect.fail(
        new RouteRequestError({
          message: `'${serverName}' isn't available in this conversation. Start or resume the conversation first.`,
        }),
      );
};

const composerCall = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new RouteRequestError({ message: error instanceof Error ? error.message : String(error) }),
  });

/** Repository servers with their approval, and whether the project overrides or turns them off. */
const repositoryServersResult = (
  projectMcpConfigService: typeof ProjectMcpConfigService.Service,
  projectId: ProjectId,
  layer: McpRepositoryLayer,
) =>
  projectMcpConfigService.readProjectStoredConfig(projectId).pipe(
    Effect.mapError((error) => new RouteRequestError({ message: error.message })),
    Effect.map((project) => {
      const projectNames = new Set(Object.keys(project.servers).map(mcpServerNameKey));
      const disabled = new Set((project.disabledCommonServers ?? []).map(mcpServerNameKey));
      return {
        projectId,
        ...(layer.path ? { path: layer.path } : {}),
        found: layer.found,
        servers: layer.entries.map((entry) => ({
          name: entry.name,
          server: entry.server,
          definitionHash: entry.definitionHash,
          state: entry.approved
            ? ("approved" as const)
            : entry.changed
              ? ("changed" as const)
              : ("needs-approval" as const),
          overridden: projectNames.has(mcpServerNameKey(entry.name)),
          disabled: disabled.has(mcpServerNameKey(entry.name)),
        })),
        issues: [...layer.issues],
      };
    }),
  );

/**
 * MCP configuration, status, discovery, probing, secret storage, OAuth/login,
 * live session reload, and MCP Apps routes.
 */
export const mcpRoutes = ({
  projectMcpConfigService,
  mcpRuntimeService,
  mcpHub,
  mcpHubAuth,
  mcpHubGovernance,
  mcpRepositoryServers,
  mcpCatalog,
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

  [WS_METHODS.mcpGetHubStatus]: (request) =>
    Effect.succeed({ servers: mcpHub ? [...mcpHub.status(request.projectId)] : [] }),

  [WS_METHODS.mcpReconnectHubServer]: (request) =>
    Effect.gen(function* () {
      const reconnected = mcpHub
        ? yield* Effect.promise(() => mcpHub.reconnect(request.serverName, request.projectId))
        : 0;
      return { reconnected };
    }),

  [WS_METHODS.mcpGetHubAuthStatus]: (request) =>
    mcpHubAuth
      ? mcpHubAuth
          .status(request.projectId)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })))
      : Effect.succeed({ servers: [] }),

  [WS_METHODS.mcpStartHubSignIn]: (request) =>
    mcpHubAuth
      ? mcpHubAuth
          .startSignIn(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })))
      : Effect.fail(new RouteRequestError({ message: "MCP sign-in is unavailable here." })),

  [WS_METHODS.mcpCompleteHubSignIn]: (request) =>
    mcpHubAuth
      ? mcpHubAuth
          .completeSignIn(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })))
      : Effect.fail(new RouteRequestError({ message: "MCP sign-in is unavailable here." })),

  [WS_METHODS.mcpSignOutHubServer]: (request) =>
    mcpHubAuth
      ? mcpHubAuth
          .signOut(withoutTag(request))
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })))
      : Effect.succeed({ signedOut: false }),

  [WS_METHODS.mcpListToolPins]: (request) =>
    Effect.succeed({
      tools: mcpHubGovernance ? [...mcpHubGovernance.listToolPins(request.serverName)] : [],
    }),

  [WS_METHODS.mcpAcceptToolChanges]: (request) =>
    mcpHubGovernance
      ? mcpHubGovernance.acceptToolChanges(withoutTag(request))
      : Effect.succeed({ accepted: 0, stale: 0 }),

  [WS_METHODS.mcpListActivity]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const activity = mcpHubGovernance
        ? yield* mcpHubGovernance.listActivity(body)
        : { calls: [], last24h: { calls: 0, errors: 0 } };
      const stderrTail = body.serverName
        ? mcpHub?.readStderrTail(body.serverName, body.projectId)
        : undefined;
      return { ...activity, ...(stderrTail ? { stderrTail } : {}) };
    }),

  [WS_METHODS.mcpGetThreadServers]: (request) =>
    Effect.succeed(
      mcpHubGovernance ? mcpHubGovernance.threadServers(request.threadId) : { disabledServers: [] },
    ),

  [WS_METHODS.mcpSetThreadServerEnabled]: (request) =>
    mcpHubGovernance
      ? mcpHubGovernance.setThreadServerEnabled(withoutTag(request))
      : Effect.fail(
          new RouteRequestError({
            message: "Turning MCP servers off per conversation is unavailable here.",
          }),
        ),

  [WS_METHODS.mcpListComposerPrompts]: (request) =>
    Effect.gen(function* () {
      const servers = mcpHub?.sessionServers?.(request.threadId);
      if (!servers?.size) return { servers: [] };
      return {
        servers: yield* Effect.promise((signal) => listComposerPrompts(servers, signal)),
      };
    }),

  [WS_METHODS.mcpGetComposerPrompt]: (request) =>
    Effect.gen(function* () {
      const server = yield* composerServer(mcpHub, request.threadId, request.serverName);
      return yield* composerCall((signal) =>
        server
          .getPrompt({ name: request.name, arguments: { ...request.arguments } }, signal)
          .then(flattenPrompt),
      );
    }),

  [WS_METHODS.mcpCompleteComposerPrompt]: (request) =>
    Effect.gen(function* () {
      const server = yield* composerServer(mcpHub, request.threadId, request.serverName);
      const result = yield* composerCall((signal) =>
        server.complete(
          {
            ref: { type: "ref/prompt", name: request.name },
            argument: { name: request.argument, value: request.value },
            ...(request.arguments ? { context: { arguments: { ...request.arguments } } } : {}),
          },
          signal,
        ),
      );
      return { values: result.completion.values.slice(0, 100) };
    }),

  [WS_METHODS.mcpListComposerResources]: (request) =>
    Effect.gen(function* () {
      const servers = mcpHub?.sessionServers?.(request.threadId);
      if (!servers?.size) return { servers: [] };
      return {
        servers: yield* Effect.promise((signal) => listComposerResources(servers, signal)),
      };
    }),

  [WS_METHODS.mcpReadComposerResource]: (request) =>
    Effect.gen(function* () {
      const server = yield* composerServer(mcpHub, request.threadId, request.serverName);
      return yield* composerCall((signal) =>
        server
          .readResource({ uri: request.uri }, signal)
          .then((result) => shapeResourceContents(result)),
      );
    }),

  [WS_METHODS.mcpSearchCatalog]: (request) =>
    composerCall((signal) => mcpCatalog.search(withoutTag(request), signal)),

  [WS_METHODS.mcpGetRepositoryServers]: (request) =>
    Effect.gen(function* () {
      if (!mcpRepositoryServers)
        return { projectId: request.projectId, found: false, servers: [], issues: [] };
      return yield* repositoryServersResult(
        projectMcpConfigService,
        request.projectId,
        yield* mcpRepositoryServers.readLayer(request.projectId),
      );
    }),

  [WS_METHODS.mcpSetRepositoryServerTrust]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      if (!mcpRepositoryServers)
        return yield* new RouteRequestError({
          message: "Repository MCP servers are unavailable here.",
        });
      if (body.trusted) {
        const [layer, common, project] = yield* Effect.all([
          mcpRepositoryServers.readLayer(body.projectId),
          projectMcpConfigService.readCommonStoredConfig(),
          projectMcpConfigService.readProjectStoredConfig(body.projectId),
        ]).pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
        const issue = repositoryApprovalLimitIssue({
          layer,
          serverName: body.serverName,
          common: common.servers,
          project: project.servers,
          disabledCommon: project.disabledCommonServers,
        });
        if (issue) return yield* new RouteRequestError({ message: issue });
      }
      const layer = yield* mcpRepositoryServers
        .setTrust(body)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
      // The effective configuration changed: settings, status and the hub re-read it.
      yield* codexMcpEventBus.publishStatusUpdated({
        scope: "project",
        projectId: body.projectId,
        reason: "updated",
      });
      return yield* repositoryServersResult(projectMcpConfigService, body.projectId, layer);
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
