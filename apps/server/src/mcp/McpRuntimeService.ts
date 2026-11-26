import { projectMcpStatuses, boundMcpObservation, capMcpResponse } from "./mcpInspection.ts";
import { mcpProviderReads, mcpContextKey } from "./McpReadCoordinator.ts";
import { observeCodexMcpServers } from "../provider/codexMcpObservation.ts";
import type { McpAdapterObservation } from "../provider/mcpObservation.ts";
import {
  createMcpDiagnosticsSanitizer,
  sanitizeMcpReconnectResult,
} from "@t3tools/shared/mcpDiagnostics";
import { makeMcpAccountExecutionResolver } from "./accountExecution.ts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { makeClaudeProcessEnvironment } from "../provider/Drivers/ClaudeHome";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  type McpGetLoginStatusRequest as McpGetLoginStatusWireRequest,
  type McpInspectServerRequest as McpInspectServerWireRequest,
  type McpInspectServerResult,
  type McpReconnectServerRequest as McpReconnectServerWireRequest,
  type McpReconnectServerResult,
  type McpGetProviderStatusRequest as McpGetProviderStatusWireRequest,
  type McpGetServerStatusesRequest as McpGetServerStatusesWireRequest,
  type McpLoginStatusResult,
  type McpOauthLoginStatusResult,
  type McpProviderStatusResult,
  type McpServerStatusesResult,
  type McpStartLoginRequest as McpStartLoginWireRequest,
  type McpStatusUpdatedReason,
  type McpProjectServersConfig,
  type ProjectId,
  type ProviderStartOptions,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * The route resolves the selected provider instance before calling this service
 * and adds that instance's executable and home. Clients cannot supply them.
 */
interface ResolvedAccountPaths {
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
}
type McpGetLoginStatusRequest = McpGetLoginStatusWireRequest & ResolvedAccountPaths;
type McpInspectServerRequest = McpInspectServerWireRequest & ResolvedAccountPaths;
type McpReconnectServerRequest = McpReconnectServerWireRequest & ResolvedAccountPaths;
type McpGetProviderStatusRequest = McpGetProviderStatusWireRequest & ResolvedAccountPaths;
type McpGetServerStatusesRequest = McpGetServerStatusesWireRequest & ResolvedAccountPaths;
type McpStartLoginRequest = McpStartLoginWireRequest & ResolvedAccountPaths;
import {
  Clock,
  Effect,
  Exit,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  ServiceMap,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CodexControlClientRegistry } from "../codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "../codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "../codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "../codex/CodexOAuthManager.ts";
import { readCodexServerStatusPages } from "../codex/codexMcpServerStatus.ts";
import { ProjectMcpConfigService } from "./ProjectMcpConfigService.ts";
import { McpHub } from "./hub/McpHub.ts";
import { CODEX_ADMIN_MCP_CONFIG } from "./hub/nativeHubOptions.ts";
import { McpRuntimeDiagnostics } from "./McpRuntimeDiagnostics.ts";
import {
  checkClaudeProviderPreflight,
  checkCodexProviderPreflight,
} from "../provider/Layers/ProviderHealth.ts";
import { toClaudeProviderStartOptions } from "../provider/claudeProviderOptions.ts";
import { toCodexProviderStartOptions } from "../provider/codexProviderOptions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_STATUS_RETENTION_MS = 10 * 60_000;
/** Claude's CLI completes OAuth itself; F5 only watches the source session for the result. */
const CLAUDE_LOGIN_POLL_MS = 2_000;
/** claude.ai connectors authorize on claude.ai without a callback, so F5 retries the connection. */
const CLAUDE_CONNECTOR_RECONNECT_MS = 5_000;
const CLAUDE_CONNECTOR_RECONNECT_MAX_MS = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readProviderOptions(input: {
  readonly provider: McpGetProviderStatusRequest["provider"];
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
}): ProviderStartOptions | undefined {
  return input.provider === "codex"
    ? toCodexProviderStartOptions({
        binaryPath: trimToUndefined(input.binaryPath),
        homePath: trimToUndefined(input.homePath),
      })
    : toClaudeProviderStartOptions({
        binaryPath: trimToUndefined(input.binaryPath),
      });
}

function loginStatusKey(input: McpGetLoginStatusRequest): string {
  return [input.provider, input.instanceId ?? "", input.projectId, input.serverName ?? ""].join(
    "\u0000",
  );
}

function readIdleLoginStatus(
  input: McpGetLoginStatusRequest,
  mode: McpLoginStatusResult["mode"],
): McpLoginStatusResult {
  return {
    target: input.serverName ? "server" : "provider",
    mode,
    provider: input.provider,
    projectId: input.projectId,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    ...(input.serverName ? { serverName: input.serverName } : {}),
    status: "idle",
  };
}

/** Whether `name` is one of F5's saved servers (Claude may report a normalized spelling). */
function isConfiguredServer(servers: McpProjectServersConfig, name: string): boolean {
  const key = mcpServerNameKey(name);
  return Object.keys(servers).some((candidate) => mcpServerNameKey(candidate) === key);
}

/** Provider sign-in is only for the provider's own servers; F5's sign in through the hub. */
function configuredServerSignInError(serverName: string) {
  return new McpRuntimeServiceError({
    message: `Codex and Claude reach '${serverName}' through F5. Sign in from the server's Sign-in tab in MCP settings; earlier Codex or Claude sign-ins are not carried over.`,
  });
}

export class McpRuntimeServiceError extends Schema.TaggedErrorClass<McpRuntimeServiceError>()(
  "McpRuntimeServiceError",
  {
    message: Schema.String,
  },
) {}

export interface McpRuntimeServiceShape {
  readonly getProviderStatus: (
    input: McpGetProviderStatusRequest,
  ) => Effect.Effect<McpProviderStatusResult, McpRuntimeServiceError>;
  readonly getServerStatuses: (
    input: McpGetServerStatusesRequest,
  ) => Effect.Effect<McpServerStatusesResult, McpRuntimeServiceError>;
  readonly inspectServer: (
    input: McpInspectServerRequest & { readonly provider: McpGetProviderStatusRequest["provider"] },
  ) => Effect.Effect<McpInspectServerResult, McpRuntimeServiceError>;
  readonly reconnectServer: (
    input: McpReconnectServerRequest & {
      readonly provider: McpGetProviderStatusRequest["provider"];
    },
  ) => Effect.Effect<McpReconnectServerResult, McpRuntimeServiceError>;
  readonly sanitizeReconnectResult: (
    input: McpGetServerStatusesRequest,
    result: McpReconnectServerResult,
  ) => Effect.Effect<McpReconnectServerResult, McpRuntimeServiceError>;
  readonly startLogin: (
    input: McpStartLoginRequest,
  ) => Effect.Effect<McpLoginStatusResult, McpRuntimeServiceError>;
  readonly getLoginStatus: (input: McpGetLoginStatusRequest) => Effect.Effect<McpLoginStatusResult>;
}

export class McpRuntimeService extends ServiceMap.Service<
  McpRuntimeService,
  McpRuntimeServiceShape
>()("t3/mcp/McpRuntimeService") {}

const makeMcpRuntimeService = Effect.gen(function* () {
  const resolveExecution = yield* makeMcpAccountExecutionResolver;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const codexMcpSyncService = yield* CodexMcpSyncService;
  const codexControlClientRegistry = yield* CodexControlClientRegistry;
  const codexOAuthManager = yield* CodexOAuthManager;
  const mcpRuntimeDiagnostics = yield* McpRuntimeDiagnostics;
  const providerService = yield* ProviderService;
  const eventBus = yield* CodexMcpEventBus;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(McpHub));
  const runLoginTask = yield* FiberSet.makeRuntime<never>();
  const loginStatuses = new Map<string, McpLoginStatusResult>();
  const loginStatusTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearLoginStatusTimer = (key: string) => {
    const timer = loginStatusTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      loginStatusTimers.delete(key);
    }
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const timer of loginStatusTimers.values()) {
        clearTimeout(timer);
      }
      loginStatusTimers.clear();
    }),
  );

  const readProviderPreflight = (input: McpGetProviderStatusRequest) =>
    Effect.gen(function* () {
      const execution = yield* resolveExecution({
        ...input,
        providerOptions: readProviderOptions(input),
      }).pipe(Effect.mapError((cause) => new McpRuntimeServiceError({ message: cause.message })));
      const accountEnvironment = execution.environment;
      const providerOptions = readProviderOptions(input);
      if (input.provider === "codex") {
        return yield* checkCodexProviderPreflight({
          ...(providerOptions ? { providerOptions } : {}),
          processEnvironment: accountEnvironment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        );
      }

      return yield* checkClaudeProviderPreflight({
        ...(providerOptions ? { providerOptions } : {}),
        processEnvironment: yield* makeClaudeProcessEnvironment(
          { homePath: input.homePath ?? "" },
          accountEnvironment,
          execution.instanceEnvironment,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
    });

  const publishLoginCompletion = (input: {
    readonly provider: McpStartLoginRequest["provider"];
    readonly instanceId?: ProviderInstanceId;
    readonly projectId: McpStartLoginRequest["projectId"];
    readonly configVersion?: string;
  }) =>
    eventBus.publishStatusUpdated({
      provider: input.provider,
      scope: "project",
      projectId: input.projectId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      reason: "login-completed" satisfies McpStatusUpdatedReason,
      ...(input.configVersion ? { configVersion: input.configVersion } : {}),
    });

  const setLoginStatus = (input: McpGetLoginStatusRequest, status: McpLoginStatusResult) => {
    const key = loginStatusKey(input);
    clearLoginStatusTimer(key);
    const previous = loginStatuses.get(key);
    loginStatuses.set(key, status);
    // Settings no longer poll sign-in, so a failed attempt is announced like a completed
    // one (completions publish where they finish, with the applied config version).
    if (status.status === "failed" && previous?.status === "pending")
      Effect.runFork(
        publishLoginCompletion({
          provider: input.provider,
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        }),
      );
    if (status.status !== "pending") {
      loginStatusTimers.set(
        key,
        setTimeout(() => {
          loginStatuses.delete(key);
          loginStatusTimers.delete(key);
        }, LOGIN_STATUS_RETENTION_MS),
      );
    }
  };

  const getProviderStatus: McpRuntimeServiceShape["getProviderStatus"] = (input) =>
    Effect.gen(function* () {
      const effectiveConfig = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(
          Effect.mapError(
            (error) =>
              new McpRuntimeServiceError({
                message: error.message,
              }),
          ),
        );
      const preflight = yield* readProviderPreflight(input);

      if (input.provider === "codex") {
        const providerOptions = readProviderOptions(input);
        const codexStatus = yield* codexMcpSyncService.getStatus({
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          ...(providerOptions ? { providerOptions } : {}),
        });

        return {
          provider: input.provider,
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          support: codexStatus.support,
          available: preflight.available,
          authStatus: preflight.authStatus,
          ...(codexStatus.supportMessage ? { supportMessage: codexStatus.supportMessage } : {}),
          ...(codexStatus.configVersion ? { configVersion: codexStatus.configVersion } : {}),
        } satisfies McpProviderStatusResult;
      }

      return {
        provider: input.provider,
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        support: preflight.available ? "supported" : "unavailable",
        available: preflight.available,
        authStatus: preflight.authStatus,
        ...(preflight.message ? { supportMessage: preflight.message } : {}),
        configVersion: effectiveConfig.effectiveVersion,
      } satisfies McpProviderStatusResult;
    });

  const runtimeError = (cause: unknown) =>
    new McpRuntimeServiceError({
      message: cause instanceof Error ? cause.message : "MCP observation failed.",
    });
  /**
   * Codex's admin app-server, for status, reconnect and sign-in outside a conversation.
   * F5's servers reach Codex through the hub, so it carries none of them, starts none
   * of them, and one pooled client outlives saves.
   */
  const codexAdminClient = (instanceId: ProviderInstanceId, projectId: ProjectId) =>
    codexControlClientRegistry
      .getAdminClient({ projectId, instanceId, ...CODEX_ADMIN_MCP_CONFIG })
      .pipe(Effect.mapError(runtimeError));
  const readRedactionContext = (input: McpGetServerStatusesRequest) =>
    Effect.gen(function* () {
      const effective = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(Effect.mapError(runtimeError));
      const identity = yield* resolveExecution(input).pipe(Effect.option);
      const environment = Option.isSome(identity) ? identity.value.environment : {};
      const additionalValues = Object.values(effective.servers).flatMap((server) =>
        server.bearerTokenEnvVar && environment[server.bearerTokenEnvVar]
          ? [environment[server.bearerTokenEnvVar]!]
          : [],
      );
      return { servers: effective.servers, additionalValues };
    });
  const sanitizeReconnectResult: McpRuntimeServiceShape["sanitizeReconnectResult"] = (
    input,
    result,
  ) =>
    readRedactionContext(input).pipe(
      Effect.map(({ servers, additionalValues }) =>
        sanitizeMcpReconnectResult(result, servers, additionalValues),
      ),
    );

  const observe = (input: McpGetServerStatusesRequest) =>
    Effect.gen(function* () {
      const identity = yield* resolveExecution(input).pipe(Effect.mapError(runtimeError));
      const effective = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(Effect.mapError(runtimeError));
      const additionalValues = Object.values(effective.servers).flatMap((server) =>
        server.bearerTokenEnvVar && identity.environment[server.bearerTokenEnvVar]
          ? [identity.environment[server.bearerTokenEnvVar]!]
          : [],
      );
      // This branch must precede provider preflight: a conversation read never creates a control client.
      const live = providerService.readMcpSessionStatuses
        ? yield* providerService
            .readMcpSessionStatuses({
              ...input,
              instanceId: identity.instanceId,
              desiredVersion: effective.effectiveVersion,
            })
            .pipe(Effect.mapError(runtimeError))
        : { sessions: [], selected: undefined, observation: undefined };
      let observation: McpAdapterObservation | undefined = live.observation;
      let support: McpServerStatusesResult["support"] = "supported";
      let supportMessage: string | undefined;
      if (!live.selected && input.threadId)
        return yield* runtimeError(new Error("The requested conversation is unavailable."));
      if (!live.selected && input.provider === "codex") {
        const providerStatus = yield* getProviderStatus(input);
        support = providerStatus.support;
        supportMessage = providerStatus.supportMessage;
        if (support === "supported") {
          const client = yield* codexAdminClient(identity.instanceId, input.projectId);
          const pages = yield* Effect.tryPromise({
            try: () =>
              mcpProviderReads.read(
                JSON.stringify([
                  "configurationCheck",
                  input.projectId,
                  identity.instanceId,
                  identity.fingerprint,
                  effective.effectiveVersion,
                  mcpContextKey(client.getMcpObservationContext?.() ?? client),
                ]),
                (signal, deadline) => readCodexServerStatusPages(client, { signal, deadline }),
              ),
            catch: runtimeError,
          });
          observation = {
            servers: observeCodexMcpServers(
              pages.entries,
              // This client lists only Codex's own servers.
              new Set<string>(),
            ),
            complete: pages.complete,
            capabilities: { tools: true, inputSchemas: true, resources: true },
            ...(pages.anomaly ? { omissions: [pages.anomaly] } : {}),
          };
        }
      }
      const currentIdentity = yield* resolveExecution
        .readIdentity(input)
        .pipe(Effect.mapError(runtimeError));
      if (identity.identity !== currentIdentity.identity)
        return yield* runtimeError(
          new Error("MCP account or project changed while reading status. Refresh."),
        );
      const latest = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(Effect.mapError(runtimeError));
      if (latest.effectiveVersion !== effective.effectiveVersion)
        return yield* runtimeError(
          new Error("The MCP observation was superseded by a newer saved version. Refresh."),
        );
      if (observation)
        observation = boundMcpObservation(observation, effective.servers, additionalValues);
      const result: McpServerStatusesResult = {
        provider: input.provider,
        projectId: input.projectId,
        instanceId: identity.instanceId,
        fingerprint: identity.fingerprint,
        source: live.selected ? "conversation" : "configurationCheck",
        observedAt: nowIso(),
        desiredVersion: effective.effectiveVersion,
        configVersion: effective.effectiveVersion,
        ...(live.selected
          ? {
              threadId: live.selected.threadId,
              generation: live.selected.generation,
              ...(live.selected.appliedVersion
                ? { appliedVersion: live.selected.appliedVersion }
                : {}),
            }
          : {}),
        complete: observation?.complete ?? (input.provider === "claudeAgent" && !live.selected),
        sessions: live.sessions,
        ...(observation?.omissions ? { omissions: observation.omissions } : {}),
        support,
        ...(supportMessage ? { supportMessage } : {}),
        statuses: [
          ...projectMcpStatuses(effective.servers, observation, input.provider),
          ...(effective.issues ?? [])
            .filter((issue) => issue.serverName && !effective.servers[issue.serverName])
            .map((issue) => ({
              name: issue.serverName!,
              state: "failed" as const,
              ownership: "managed" as const,
              authStatus: "unknown" as const,
              toolCount: 0,
              resourceCount: 0,
              resourceTemplateCount: 0,
              message: issue.message,
            })),
        ],
      };
      return { result, observation, effective, additionalValues };
    });

  const getServerStatuses: McpRuntimeServiceShape["getServerStatuses"] = (input) =>
    observe(input).pipe(Effect.map(({ result }) => capMcpResponse(result)));

  const inspectServer: McpRuntimeServiceShape["inspectServer"] = (input) =>
    Effect.gen(function* () {
      const { result, observation, effective, additionalValues } = yield* observe(input);
      const ownership =
        input.ownership ??
        (Object.keys(effective.servers).some(
          (name) => mcpServerNameKey(name) === mcpServerNameKey(input.serverName),
        )
          ? "managed"
          : undefined);
      const matches =
        observation?.servers.filter(
          (server) =>
            mcpServerNameKey(server.name) === mcpServerNameKey(input.serverName) &&
            (!ownership || server.ownership === ownership),
        ) ?? [];
      const server = matches.length === 1 ? matches[0] : undefined;
      const sanitizer = createMcpDiagnosticsSanitizer(effective.servers, additionalValues);
      const historical =
        result.threadId && result.instanceId && result.generation !== undefined
          ? yield* mcpRuntimeDiagnostics.listLatestServerDiagnostics({
              projectId: input.projectId,
              provider: input.provider,
              instanceId: result.instanceId,
              threadId: result.threadId,
              sessionGeneration: result.generation,
            })
          : [];
      return capMcpResponse({
        ...result,
        serverName: input.serverName,
        capabilities: observation?.capabilities ?? {
          tools: false,
          inputSchemas: false,
          resources: false,
        },
        tools: server?.tools ?? [],
        resources: server?.resources ?? [],
        resourceTemplates: server?.resourceTemplates ?? [],
        diagnostics: historical.slice(0, 20).map((diagnostic) => ({
          ...diagnostic,
          ...(diagnostic.message
            ? { message: sanitizer.text(diagnostic.message).slice(0, 2000) }
            : {}),
        })),
      });
    });

  // Codex Apply is performed by the reactor at the transport boundary, after this admin reload.
  const reconnectServer: McpRuntimeServiceShape["reconnectServer"] = (input) =>
    Effect.gen(function* () {
      const identity = yield* resolveExecution
        .readIdentity(input)
        .pipe(Effect.mapError(runtimeError));
      const effective = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(Effect.mapError(runtimeError));
      if (isConfiguredServer(effective.servers, input.serverName)) {
        // The provider's connection is to F5's endpoint; the server's own is the hub's.
        if (!hub) return yield* runtimeError(new Error("F5's MCP hub is unavailable."));
        const reconnected = yield* Effect.promise(() =>
          hub.reconnect(input.serverName, input.projectId),
        );
        return {
          settingsConnectionReloaded: false,
          sessionsMatched: reconnected,
          sessionsReconnected: reconnected,
          failures: [],
        };
      }
      if (input.provider === "claudeAgent") {
        if (!providerService.reconnectMcpServerForProject)
          return yield* runtimeError(new Error("This provider does not support reconnect."));
        const result = yield* providerService
          .reconnectMcpServerForProject({ ...input, instanceId: identity.instanceId })
          .pipe(Effect.mapError(runtimeError));
        return result;
      }

      const client = yield* codexAdminClient(identity.instanceId, input.projectId);
      const reloaded = yield* Effect.tryPromise({
        try: () => client.reloadMcpServer(),
        catch: runtimeError,
      }).pipe(Effect.result);
      return {
        settingsConnectionReloaded: reloaded._tag === "Success",
        sessionsMatched: 0,
        sessionsReconnected: 0,
        failures:
          reloaded._tag === "Failure"
            ? [
                {
                  message: reloaded.failure.message,
                },
              ]
            : [],
      };
    });

  const sanitizeLoginMessage = (input: McpStartLoginRequest, message: string) =>
    readRedactionContext(input).pipe(
      Effect.map(({ servers, additionalValues }) =>
        createMcpDiagnosticsSanitizer(servers, additionalValues)
          .text(message)
          .trim()
          .slice(0, 2000),
      ),
      Effect.orElseSucceed(() => ""),
      Effect.map((text) => text || "MCP sign-in failed."),
    );

  const reconnectClaudeSessionsAfterLogin = (
    input: McpStartLoginRequest & {
      readonly serverName: string;
      readonly instanceId: ProviderInstanceId;
    },
    ownership: "managed" | "external",
    excludeThreadId?: ThreadId,
  ) =>
    providerService.reconnectMcpServerForProject
      ? providerService
          .reconnectMcpServerForProject({
            provider: "claudeAgent",
            projectId: input.projectId,
            instanceId: input.instanceId,
            serverName: input.serverName,
            ...(ownership === "external" ? { allowExternal: true } : {}),
            ...(excludeThreadId ? { excludeThreadIds: [excludeThreadId] } : {}),
          })
          .pipe(
            Effect.flatMap((result) =>
              result.failures.length > 0
                ? Effect.logWarning(
                    "Claude MCP sign-in succeeded but some sessions did not reconnect.",
                    {
                      projectId: input.projectId,
                      instanceId: input.instanceId,
                      failedSessions: result.failures.length,
                    },
                  )
                : Effect.void,
            ),
            Effect.catch((cause) =>
              Effect.logWarning(
                "Claude MCP sign-in succeeded but reconnecting other sessions failed.",
                { cause, projectId: input.projectId, instanceId: input.instanceId },
              ),
            ),
          )
      : Effect.void;

  const watchClaudeServerLogin = (
    input: McpStartLoginRequest & {
      readonly serverName: string;
      readonly instanceId: ProviderInstanceId;
    },
    attempt: McpLoginStatusResult,
    started: {
      readonly threadId: ThreadId;
      readonly generation: number;
      readonly callbackExpected: boolean;
      readonly ownership: "managed" | "external";
    },
    desiredVersion: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const key = loginStatusKey(input);
      // A newer attempt (or retention expiry) replaces the stored status and ends this watcher.
      const isCurrent = () => loginStatuses.get(key) === attempt;
      const fail = (error: string) =>
        Effect.sync(() => {
          if (!isCurrent()) return;
          setLoginStatus(input, { ...attempt, status: "failed", completedAt: nowIso(), error });
        });
      const ended = "The conversation ended before sign-in completed.";
      const startedAtMs = yield* Clock.currentTimeMillis;
      const deadline = startedAtMs + LOGIN_TIMEOUT_MS;
      let reconnectDelayMs = CLAUDE_CONNECTOR_RECONNECT_MS;
      let nextReconnectAtMs = startedAtMs + reconnectDelayMs;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.sleep(CLAUDE_LOGIN_POLL_MS);
        if (!isCurrent()) return;
        if (!providerService.readMcpSessionStatuses)
          return yield* fail("This provider runtime cannot report MCP status.");
        const live = yield* providerService
          .readMcpSessionStatuses({
            provider: "claudeAgent",
            projectId: input.projectId,
            instanceId: input.instanceId,
            threadId: started.threadId,
            desiredVersion,
          })
          .pipe(Effect.option);
        if (!isCurrent()) return;
        const selected = Option.isSome(live) ? live.value.selected : undefined;
        if (selected && selected.generation !== started.generation) return yield* fail(ended);
        if (Option.isNone(live) || !selected) {
          // Reads also fail transiently (timeouts, superseded observations, a newly applied
          // config version). Only a missing or replaced session ends the attempt.
          const session = providerService.getLiveMcpSession
            ? yield* providerService
                .getLiveMcpSession({
                  provider: "claudeAgent",
                  projectId: input.projectId,
                  instanceId: input.instanceId,
                  threadId: started.threadId,
                })
                .pipe(Effect.option)
            : Option.none();
          if (!isCurrent()) return;
          if (
            Option.isSome(session) &&
            (!session.value || session.value.generation !== started.generation)
          )
            return yield* fail(ended);
          continue;
        }
        const server = live.value.observation?.servers.find(
          (entry) => entry.name === input.serverName,
        );
        if (server?.status === "connected") {
          setLoginStatus(input, { ...attempt, status: "completed", completedAt: nowIso() });
          yield* publishLoginCompletion({
            provider: "claudeAgent",
            projectId: input.projectId,
            instanceId: input.instanceId,
            configVersion: desiredVersion,
          });
          yield* reconnectClaudeSessionsAfterLogin(input, started.ownership, started.threadId);
          return;
        }
        if (server?.status === "failed")
          return yield* fail(
            yield* sanitizeLoginMessage(
              input,
              server.error ?? "The server failed to connect after sign-in.",
            ),
          );
        // claude.ai connectors never call back. Retry the connection with backoff, and never
        // while a turn is running, since a reconnect holds the conversation's session gate.
        const now = yield* Clock.currentTimeMillis;
        if (
          !started.callbackExpected &&
          !selected.busy &&
          now >= nextReconnectAtMs &&
          providerService.reconnectMcpServerForProject
        ) {
          yield* providerService
            .reconnectMcpServerForProject({
              provider: "claudeAgent",
              projectId: input.projectId,
              instanceId: input.instanceId,
              serverName: input.serverName,
              threadIds: [started.threadId],
              allowExternal: true,
            })
            .pipe(Effect.ignore);
          reconnectDelayMs = Math.min(reconnectDelayMs * 2, CLAUDE_CONNECTOR_RECONNECT_MAX_MS);
          nextReconnectAtMs = (yield* Clock.currentTimeMillis) + reconnectDelayMs;
        }
      }
      yield* fail("Sign-in timed out. Try again.");
    });

  /** Ends an attempt that stopped without settling (interruption or defect) so it can't stick. */
  const failIfStillCurrent = (
    input: McpGetLoginStatusRequest,
    attempt: McpLoginStatusResult,
    error: string,
  ) =>
    Effect.sync(() => {
      if (loginStatuses.get(loginStatusKey(input)) !== attempt) return;
      setLoginStatus(input, { ...attempt, status: "failed", completedAt: nowIso(), error });
    });

  const startClaudeServerLogin = (
    rawInput: McpStartLoginRequest & { readonly serverName: string },
  ) => {
    const input = {
      ...rawInput,
      instanceId: rawInput.instanceId ?? ProviderInstanceId.make(rawInput.provider),
    };
    let claimed: McpLoginStatusResult | undefined;
    return Effect.gen(function* () {
      const key = loginStatusKey(input);
      const existing = loginStatuses.get(key);
      if (existing?.status === "pending") return existing;
      if (!providerService.authenticateMcpServerForProject)
        return yield* new McpRuntimeServiceError({
          message: "This provider runtime does not support MCP sign-in.",
        });
      const placeholder: McpLoginStatusResult = {
        target: "server",
        mode: "oauth",
        provider: input.provider,
        projectId: input.projectId,
        serverName: input.serverName,
        status: "pending",
        startedAt: nowIso(),
      };
      // Claim the key before any I/O so concurrent clicks share one sign-in.
      setLoginStatus(input, placeholder);
      claimed = placeholder;
      // A start rejected before reaching the provider restores the previous outcome.
      const release = Effect.sync(() => {
        if (loginStatuses.get(key) !== placeholder) return;
        if (existing) setLoginStatus(input, existing);
        else {
          clearLoginStatusTimer(key);
          loginStatuses.delete(key);
        }
      });
      const effective = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(
          Effect.mapError(runtimeError),
          Effect.tapError(() => release),
        );
      // Provider sign-in covers only Claude's own servers; F5's sign in through the hub.
      if (isConfiguredServer(effective.servers, input.serverName)) {
        yield* release;
        return yield* configuredServerSignInError(input.serverName);
      }
      const started = yield* providerService
        .authenticateMcpServerForProject({
          provider: input.provider,
          projectId: input.projectId,
          instanceId: input.instanceId,
          serverName: input.serverName,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          desiredVersion: effective.effectiveVersion,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const message = yield* sanitizeLoginMessage(
                input,
                cause instanceof Error ? cause.message : "Failed to start MCP sign-in.",
              );
              if (loginStatuses.get(key) === placeholder)
                setLoginStatus(input, {
                  ...placeholder,
                  status: "failed",
                  completedAt: nowIso(),
                  error: message,
                });
              return yield* new McpRuntimeServiceError({ message });
            }),
          ),
        );
      if (loginStatuses.get(key) !== placeholder) return loginStatuses.get(key) ?? placeholder;
      if (!started.authUrl) {
        const completed: McpLoginStatusResult = {
          ...placeholder,
          status: "completed",
          completedAt: nowIso(),
          message: "No sign-in was needed. Reconnecting the server.",
        };
        setLoginStatus(input, completed);
        runLoginTask(
          publishLoginCompletion({
            provider: input.provider,
            projectId: input.projectId,
            instanceId: input.instanceId,
            configVersion: effective.effectiveVersion,
          }).pipe(Effect.andThen(reconnectClaudeSessionsAfterLogin(input, started.ownership))),
        );
        return completed;
      }
      const pending: McpLoginStatusResult = { ...placeholder, authorizationUrl: started.authUrl };
      setLoginStatus(input, pending);
      runLoginTask(
        watchClaudeServerLogin(input, pending, started, effective.effectiveVersion).pipe(
          Effect.ensuring(
            failIfStillCurrent(input, pending, "Sign-in stopped unexpectedly. Try again."),
          ),
        ),
      );
      return pending;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || !claimed
          ? Effect.void
          : failIfStillCurrent(input, claimed, "Sign-in was interrupted. Try again."),
      ),
    );
  };

  const toCodexOauthLoginResult = (
    input: McpStartLoginRequest & { readonly serverName: string },
    status: McpOauthLoginStatusResult,
  ): McpLoginStatusResult => ({
    target: "server",
    mode: "oauth",
    provider: "codex",
    projectId: input.projectId,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    serverName: input.serverName,
    status: status.status,
    ...(status.authorizationUrl ? { authorizationUrl: status.authorizationUrl } : {}),
    ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    ...(status.completedAt ? { completedAt: status.completedAt } : {}),
    ...(status.message ? { message: status.message } : {}),
    ...(status.error ? { error: status.error } : {}),
  });

  const codexOauthManagerInput = (
    input: McpStartLoginRequest & { readonly serverName: string },
  ) => ({
    projectId: input.projectId,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    serverName: input.serverName,
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(input.homePath ? { homePath: input.homePath } : {}),
  });

  /** Servers from the profile's own Codex config sign in through the account's app-server. */
  const startCodexExternalLogin = (input: McpStartLoginRequest & { readonly serverName: string }) =>
    Effect.gen(function* () {
      const observed = yield* observe({
        provider: input.provider,
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.homePath ? { homePath: input.homePath } : {}),
      }).pipe(
        Effect.timeoutOption("10 seconds"),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value.observation)
            : Effect.fail(
                new McpRuntimeServiceError({ message: "MCP read timed out. Try again." }),
              ),
        ),
      );
      const matches =
        observed?.servers.filter(
          (server) => mcpServerNameKey(server.name) === mcpServerNameKey(input.serverName),
        ) ?? [];
      const server =
        matches.length === 1 && matches[0]!.ownership === "external" ? matches[0] : undefined;
      if (!server)
        return yield* new McpRuntimeServiceError({
          message: `MCP server '${input.serverName}' is not configured for this Codex account.`,
        });
      return yield* codexOAuthManager
        .startLogin(codexOauthManagerInput({ ...input, serverName: server.name }))
        .pipe(
          Effect.map((status) => toCodexOauthLoginResult(input, status)),
          Effect.catch((error) =>
            sanitizeLoginMessage(input, error.message).pipe(
              Effect.flatMap((message) => Effect.fail(new McpRuntimeServiceError({ message }))),
            ),
          ),
        );
    });

  const startLogin: McpRuntimeServiceShape["startLogin"] = (input) =>
    Effect.gen(function* () {
      if (input.provider === "claudeAgent" && input.serverName) {
        return yield* startClaudeServerLogin({ ...input, serverName: input.serverName });
      }

      if (input.provider === "codex" && !input.serverName) {
        return yield* new McpRuntimeServiceError({
          message: "Codex MCP login requires a server name.",
        });
      }

      const existing = loginStatuses.get(loginStatusKey(input));
      if (existing?.status === "pending") {
        return existing;
      }

      if (input.provider === "claudeAgent") {
        return yield* new McpRuntimeServiceError({
          message: "Sign this Claude account in from Settings > Profiles, then refresh this page.",
        });
      }

      // Only Codex's own servers (its config.toml) sign in here; F5's sign in through the hub.
      const configured = yield* projectMcpConfigService
        .readEffectiveRuntimeConfig(input.projectId)
        .pipe(Effect.mapError(runtimeError));
      if (isConfiguredServer(configured.servers, input.serverName!))
        return yield* configuredServerSignInError(input.serverName!);
      return yield* startCodexExternalLogin({ ...input, serverName: input.serverName! });
    });

  const getLoginStatus: McpRuntimeServiceShape["getLoginStatus"] = (input) =>
    Effect.gen(function* () {
      if (input.provider === "claudeAgent" && input.serverName) {
        const normalized = {
          ...input,
          instanceId: input.instanceId ?? ProviderInstanceId.make(input.provider),
        };
        return (
          loginStatuses.get(loginStatusKey(normalized)) ?? readIdleLoginStatus(normalized, "oauth")
        );
      }

      if (input.provider === "codex" && input.serverName) {
        const effective = yield* projectMcpConfigService
          .readEffectiveRuntimeConfig(input.projectId)
          .pipe(Effect.option);
        // Unstored names are Codex's own (profile config.toml) servers, which use
        // app-server OAuth. F5's servers sign in through the hub.
        if (
          Option.isSome(effective) &&
          !isConfiguredServer(effective.value.servers, input.serverName)
        ) {
          const loginInput = { ...input, serverName: input.serverName };
          const status = yield* codexOAuthManager.getStatus(codexOauthManagerInput(loginInput));
          return toCodexOauthLoginResult(loginInput, status);
        }
      }

      const existing = loginStatuses.get(loginStatusKey(input));
      if (existing) {
        return existing;
      }

      return readIdleLoginStatus(input, "cli");
    });

  const safeObservationRequest = <A>(
    input: McpGetServerStatusesRequest,
    request: Effect.Effect<A, McpRuntimeServiceError>,
    bounded = true,
  ) => {
    const timed = bounded
      ? request.pipe(
          Effect.timeoutOption("10 seconds"),
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  new McpRuntimeServiceError({ message: "MCP read timed out. Try Refresh." }),
                ),
          ),
        )
      : request;
    return timed.pipe(
      Effect.catch((error) =>
        readRedactionContext(input).pipe(
          Effect.orElseSucceed(() => ({ servers: {}, additionalValues: [] as string[] })),
          Effect.flatMap(({ servers, additionalValues }) =>
            Effect.fail(
              new McpRuntimeServiceError({
                message: createMcpDiagnosticsSanitizer(servers, additionalValues).text(
                  error.message,
                ),
              }),
            ),
          ),
        ),
      ),
    );
  };

  return {
    getProviderStatus,
    getServerStatuses: (input) => safeObservationRequest(input, getServerStatuses(input)),
    inspectServer: (input) => safeObservationRequest(input, inspectServer(input)),
    reconnectServer: (input) =>
      safeObservationRequest(
        input,
        reconnectServer(input).pipe(
          Effect.flatMap((result) => sanitizeReconnectResult(input, result)),
        ),
        false,
      ),
    sanitizeReconnectResult,
    startLogin,
    getLoginStatus,
  } satisfies McpRuntimeServiceShape;
});

export const McpRuntimeServiceLive = Layer.effect(McpRuntimeService, makeMcpRuntimeService);
