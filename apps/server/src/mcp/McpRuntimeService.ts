import {
  type McpGetLoginStatusRequest,
  type McpGetProviderStatusRequest,
  type McpGetServerStatusesRequest,
  type McpLoginStatusResult,
  type McpProviderStatusResult,
  type McpServerStatusEntry,
  type McpServerStatusesResult,
  type McpStartLoginRequest,
  type McpStatusUpdatedReason,
  type McpServerDefinition,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect, FiberSet, FileSystem, Layer, Option, Path, Schema, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type CodexControlMcpServerStatus } from "../codex/CodexControlClient.ts";
import { CodexControlClientRegistry } from "../codex/CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "../codex/CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "../codex/CodexMcpSyncService.ts";
import { CodexOAuthManager } from "../codex/CodexOAuthManager.ts";
import {
  findCodexServerStatusByName,
  listAllCodexServerStatuses,
} from "../codex/codexMcpServerStatus.ts";
import { ProjectMcpConfigService } from "./ProjectMcpConfigService.ts";
import { combineStatusMessage } from "./combineStatusMessage.ts";
import {
  checkClaudeProviderPreflight,
  checkCodexProviderPreflight,
} from "../provider/Layers/ProviderHealth.ts";
import { toClaudeProviderStartOptions } from "../provider/claudeProviderOptions.ts";
import { toCodexProviderStartOptions } from "../provider/codexProviderOptions.ts";
import { buildCodexCliEnvOverrides, runCodexCliCommand } from "../provider/providerCli.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { translateMcpForCodex } from "@t3tools/shared/mcpTranslation";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_STATUS_RETENTION_MS = 10 * 60_000;
const WINDOWS_SHELL_META_PATTERN = /[&|><^%!`"'\r\n]/u;
const WINDOWS_SAFE_SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const WINDOWS_SAFE_SCOPE_PATTERN = /^[A-Za-z0-9_./:-]+$/u;

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

function readCliMessage(output: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}) {
  const stderr = output.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = output.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return output.code === 0 ? undefined : `Command exited with code ${output.code}.`;
}

function loginStatusKey(input: McpGetLoginStatusRequest): string {
  return [input.provider, input.projectId, input.serverName ?? ""].join("\u0000");
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
    ...(input.serverName ? { serverName: input.serverName } : {}),
    status: "idle",
  };
}

function mapCodexServerStatus(
  name: string,
  server: McpServerDefinition,
  controlStatus: CodexControlMcpServerStatus | undefined,
  providerStatus: McpProviderStatusResult,
): McpServerStatusEntry {
  if (server.enabled === false) {
    return {
      name,
      state: "disabled",
      authStatus: "unknown",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      message: "Disabled in the shared MCP config.",
    };
  }

  if (providerStatus.support !== "supported") {
    return {
      name,
      state: "unknown",
      authStatus: providerStatus.authStatus,
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      ...(providerStatus.supportMessage ? { message: providerStatus.supportMessage } : {}),
    };
  }

  if (!controlStatus) {
    return {
      name,
      state: "unknown",
      authStatus: "unknown",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      message: "Codex did not report a live status for this MCP server.",
    };
  }

  const toolCount = Object.keys(controlStatus.tools ?? {}).length;
  const resourceCount = controlStatus.resources?.length ?? 0;
  const resourceTemplateCount = controlStatus.resourceTemplates?.length ?? 0;
  if (controlStatus.authStatus === "notLoggedIn") {
    return {
      name,
      state: "login-required",
      authStatus: "unauthenticated",
      toolCount,
      resourceCount,
      resourceTemplateCount,
      message: "Codex can see this server, but it is not logged in yet.",
    };
  }

  return {
    name,
    state: "ready",
    authStatus: "authenticated",
    toolCount,
    resourceCount,
    resourceTemplateCount,
  };
}

function mapClaudeServerStatus(
  name: string,
  server: McpServerDefinition,
  providerStatus: McpProviderStatusResult,
): McpServerStatusEntry {
  if (server.enabled === false) {
    return {
      name,
      state: "disabled",
      authStatus: "unknown",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      message: "Disabled in the shared MCP config.",
    };
  }

  if (!providerStatus.available) {
    return {
      name,
      state: "unknown",
      authStatus: providerStatus.authStatus,
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      ...(providerStatus.supportMessage ? { message: providerStatus.supportMessage } : {}),
    };
  }

  if (providerStatus.authStatus === "unauthenticated") {
    return {
      name,
      state: "login-required",
      authStatus: "unauthenticated",
      toolCount: 0,
      resourceCount: 0,
      resourceTemplateCount: 0,
      message:
        "Claude is not authenticated yet. Run `claude auth login` in a terminal, then refresh this page.",
    };
  }

  return {
    name,
    state: "unknown",
    authStatus: providerStatus.authStatus,
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
  };
}

function supportsCodexOauthLogin(server: McpServerDefinition): boolean {
  return server.type === "http" || typeof server.oauthResource === "string";
}

function isWindowsShellSafePath(value: string): boolean {
  return !WINDOWS_SHELL_META_PATTERN.test(value);
}

function validateWindowsCliLoginInput(input: {
  readonly serverName: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly binaryPath?: string;
}): McpRuntimeServiceError | null {
  if (process.platform !== "win32") {
    return null;
  }

  if (!WINDOWS_SAFE_SERVER_NAME_PATTERN.test(input.serverName)) {
    return new McpRuntimeServiceError({
      message:
        "MCP server names used for CLI login must only contain letters, numbers, dots, underscores, or dashes on Windows.",
    });
  }

  for (const scope of input.scopes ?? []) {
    if (!WINDOWS_SAFE_SCOPE_PATTERN.test(scope)) {
      return new McpRuntimeServiceError({
        message:
          "MCP login scopes contain unsupported characters for Windows shell execution. Remove shell metacharacters and try again.",
      });
    }
  }

  if (input.binaryPath && !isWindowsShellSafePath(input.binaryPath)) {
    return new McpRuntimeServiceError({
      message:
        "The configured CLI binary path contains unsupported shell metacharacters on Windows. Use a plain executable path and try again.",
    });
  }

  return null;
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
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const codexMcpSyncService = yield* CodexMcpSyncService;
  const codexControlClientRegistry = yield* CodexControlClientRegistry;
  const codexOAuthManager = yield* CodexOAuthManager;
  const providerService = yield* ProviderService;
  const eventBus = yield* CodexMcpEventBus;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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

  const readProviderPreflight = (input: McpGetProviderStatusRequest) => {
    const providerOptions = readProviderOptions(input);
    if (input.provider === "codex") {
      return checkCodexProviderPreflight(providerOptions ? { providerOptions } : undefined).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
    }

    return checkClaudeProviderPreflight(providerOptions ? { providerOptions } : undefined).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    );
  };

  const publishLoginCompletion = (input: {
    readonly provider: McpStartLoginRequest["provider"];
    readonly projectId: McpStartLoginRequest["projectId"];
    readonly configVersion?: string;
  }) =>
    eventBus.publishStatusUpdated({
      provider: input.provider,
      scope: "project",
      projectId: input.projectId,
      reason: "login-completed" satisfies McpStatusUpdatedReason,
      ...(input.configVersion ? { configVersion: input.configVersion } : {}),
    });

  const runBackgroundCodexReloadAfterLogin = (input: {
    readonly projectId: McpStartLoginRequest["projectId"];
    readonly serverName?: string;
    readonly providerOptions?: ProviderStartOptions;
    readonly configVersion: string;
  }) =>
    runLoginTask(
      providerService
        .reloadMcpConfigForProject({
          provider: "codex",
          projectId: input.projectId,
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        })
        .pipe(
          Effect.as<string | undefined>(undefined),
          Effect.catch((cause) =>
            Effect.logWarning("Codex MCP login succeeded but reloading live sessions failed.", {
              cause,
              projectId: input.projectId,
              serverName: input.serverName,
            }).pipe(
              Effect.as(
                "Login completed, but reloading live Codex sessions failed. Apply the shared MCP config to live sessions to retry.",
              ),
            ),
          ),
          Effect.flatMap((reloadMessage) =>
            Effect.gen(function* () {
              if (reloadMessage) {
                const statusInput = {
                  provider: "codex" as const,
                  projectId: input.projectId,
                  ...(input.serverName ? { serverName: input.serverName } : {}),
                };
                const current = loginStatuses.get(loginStatusKey(statusInput));
                if (current?.status === "completed") {
                  setLoginStatus(statusInput, {
                    ...current,
                    message: combineStatusMessage(current.message, reloadMessage),
                  });
                }
              }

              yield* publishLoginCompletion({
                provider: "codex",
                projectId: input.projectId,
                configVersion: input.configVersion,
              });
            }),
          ),
          Effect.asVoid,
        ),
    );

  const setLoginStatus = (input: McpGetLoginStatusRequest, status: McpLoginStatusResult) => {
    const key = loginStatusKey(input);
    clearLoginStatusTimer(key);
    loginStatuses.set(key, status);
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

  const readStoredServer = (input: McpGetLoginStatusRequest) =>
    Effect.gen(function* () {
      const stored = yield* projectMcpConfigService.readEffectiveStoredConfig(input.projectId).pipe(
        Effect.mapError(
          (error) =>
            new McpRuntimeServiceError({
              message: error.message,
            }),
        ),
      );
      const serverName = input.serverName;
      if (!serverName) {
        return { stored, server: undefined };
      }
      const server = stored.servers[serverName];
      if (!server) {
        return yield* new McpRuntimeServiceError({
          message: `MCP server '${serverName}' is not defined in the shared effective config.`,
        });
      }
      return { stored, server };
    });

  const readRequiredStoredServer = (
    input: McpGetLoginStatusRequest & { readonly serverName: string },
  ) =>
    Effect.gen(function* () {
      const { stored, server } = yield* readStoredServer(input);
      if (!server) {
        return yield* new McpRuntimeServiceError({
          message: `MCP server '${input.serverName}' is not defined in the shared effective config.`,
        });
      }
      return { stored, server };
    });

  const getProviderStatus: McpRuntimeServiceShape["getProviderStatus"] = (input) =>
    Effect.gen(function* () {
      const effectiveConfig = yield* projectMcpConfigService
        .readEffectiveStoredConfig(input.projectId)
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
          ...(providerOptions ? { providerOptions } : {}),
        });

        return {
          provider: input.provider,
          projectId: input.projectId,
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
        support: preflight.available ? "supported" : "unavailable",
        available: preflight.available,
        authStatus: preflight.authStatus,
        ...(preflight.message ? { supportMessage: preflight.message } : {}),
        configVersion: effectiveConfig.effectiveVersion,
      } satisfies McpProviderStatusResult;
    });

  const getServerStatuses: McpRuntimeServiceShape["getServerStatuses"] = (input) =>
    Effect.gen(function* () {
      const providerStatus = yield* getProviderStatus(input);
      const effectiveConfig = yield* projectMcpConfigService
        .readEffectiveStoredConfig(input.projectId)
        .pipe(
          Effect.mapError(
            (error) =>
              new McpRuntimeServiceError({
                message: error.message,
              }),
          ),
        );

      const orderedServers = Object.entries(effectiveConfig.servers).toSorted(([left], [right]) =>
        left.localeCompare(right),
      );

      if (input.provider === "claudeAgent") {
        return {
          provider: input.provider,
          projectId: input.projectId,
          support: providerStatus.support,
          ...(providerStatus.supportMessage
            ? { supportMessage: providerStatus.supportMessage }
            : {}),
          configVersion: effectiveConfig.effectiveVersion,
          statuses: orderedServers.map(([name, server]) =>
            mapClaudeServerStatus(name, server, providerStatus),
          ),
        } satisfies McpServerStatusesResult;
      }

      if (providerStatus.support !== "supported") {
        return {
          provider: input.provider,
          projectId: input.projectId,
          support: providerStatus.support,
          ...(providerStatus.supportMessage
            ? { supportMessage: providerStatus.supportMessage }
            : {}),
          configVersion: effectiveConfig.effectiveVersion,
          statuses: orderedServers.map(([name, server]) =>
            mapCodexServerStatus(name, server, undefined, providerStatus),
          ),
        } satisfies McpServerStatusesResult;
      }

      const providerOptions = readProviderOptions(input);
      const translatedServers = translateMcpForCodex(effectiveConfig.servers) ?? {};
      const client = yield* codexControlClientRegistry
        .getAdminClient({
          projectId: input.projectId,
          ...(providerOptions ? { providerOptions } : {}),
          mcpEffectiveConfigVersion: effectiveConfig.effectiveVersion,
          mcpServers: translatedServers,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new McpRuntimeServiceError({
                message: error.message,
              }),
          ),
        );

      const controlStatuses = yield* Effect.tryPromise({
        try: () => listAllCodexServerStatuses(client),
        catch: (cause) =>
          new McpRuntimeServiceError({
            message:
              cause instanceof Error ? cause.message : "Failed to load Codex MCP server statuses.",
          }),
      });

      return {
        provider: input.provider,
        projectId: input.projectId,
        support: providerStatus.support,
        ...(providerStatus.supportMessage ? { supportMessage: providerStatus.supportMessage } : {}),
        configVersion: effectiveConfig.effectiveVersion,
        statuses: orderedServers.map(([name, server]) =>
          mapCodexServerStatus(
            name,
            server,
            findCodexServerStatusByName(controlStatuses, name),
            providerStatus,
          ),
        ),
      } satisfies McpServerStatusesResult;
    });

  const startCliLogin = (
    input: McpStartLoginRequest,
    details: {
      readonly mode: McpLoginStatusResult["mode"];
      readonly effect: Effect.Effect<void, never, never>;
    },
  ) =>
    Effect.sync(() => {
      const pendingStatus: McpLoginStatusResult = {
        target: input.serverName ? "server" : "provider",
        mode: details.mode,
        provider: input.provider,
        projectId: input.projectId,
        ...(input.serverName ? { serverName: input.serverName } : {}),
        status: "pending",
        startedAt: nowIso(),
      };
      setLoginStatus(input, pendingStatus);
      runLoginTask(details.effect);
      return pendingStatus;
    });

  const startLogin: McpRuntimeServiceShape["startLogin"] = (input) =>
    Effect.gen(function* () {
      if (input.provider === "claudeAgent" && input.serverName) {
        return yield* new McpRuntimeServiceError({
          message: "Claude login is provider-scoped only in the current MCP settings flow.",
        });
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
          message:
            "Integrated Claude login is not available yet. Run `claude auth login` in a terminal, then refresh this page.",
        });
      }

      const { stored, server } = yield* readRequiredStoredServer({
        ...input,
        serverName: input.serverName!,
      });
      if (server.enabled === false) {
        return yield* new McpRuntimeServiceError({
          message: `MCP server '${input.serverName}' is disabled in the shared effective config.`,
        });
      }

      if (supportsCodexOauthLogin(server)) {
        return yield* codexOAuthManager
          .startLogin({
            projectId: input.projectId,
            serverName: input.serverName!,
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            ...(input.homePath ? { homePath: input.homePath } : {}),
          })
          .pipe(
            Effect.map((status) => ({
              target: "server" as const,
              mode: "oauth" as const,
              provider: "codex" as const,
              projectId: input.projectId,
              serverName: input.serverName!,
              status: status.status,
              ...(status.authorizationUrl ? { authorizationUrl: status.authorizationUrl } : {}),
              ...(status.startedAt ? { startedAt: status.startedAt } : {}),
              ...(status.completedAt ? { completedAt: status.completedAt } : {}),
              ...(status.message ? { message: status.message } : {}),
              ...(status.error ? { error: status.error } : {}),
            })),
            Effect.mapError(
              (error) =>
                new McpRuntimeServiceError({
                  message: error.message,
                }),
            ),
          );
      }

      const providerOptions = readProviderOptions(input);
      const binaryPath = trimToUndefined(input.binaryPath);
      const homePath = trimToUndefined(input.homePath);
      const windowsValidationError = validateWindowsCliLoginInput({
        serverName: input.serverName!,
        ...(server.scopes ? { scopes: server.scopes } : {}),
        ...(binaryPath ? { binaryPath } : {}),
      });
      if (windowsValidationError) {
        return yield* windowsValidationError;
      }
      const translatedServers = translateMcpForCodex(stored.servers) ?? {};
      const execute = runCodexCliCommand(
        [
          "mcp",
          "login",
          ...(server.scopes && server.scopes.length > 0
            ? ["--scopes", server.scopes.join(",")]
            : []),
          input.serverName!,
        ],
        {
          ...(binaryPath ? { binaryPath } : {}),
          ...(homePath ? { envOverrides: buildCodexCliEnvOverrides({ homePath }) } : {}),
          mcpServers: translatedServers,
        },
      ).pipe(
        Effect.timeoutOption(LOGIN_TIMEOUT_MS),
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            if (Option.isNone(result)) {
              setLoginStatus(input, {
                target: "server",
                mode: "cli",
                provider: input.provider,
                projectId: input.projectId,
                serverName: input.serverName!,
                status: "failed",
                startedAt: loginStatuses.get(loginStatusKey(input))?.startedAt ?? nowIso(),
                completedAt: nowIso(),
                error: "Codex MCP login timed out before completion.",
              });
              return;
            }

            const message = readCliMessage(result.value);
            if (result.value.code === 0) {
              setLoginStatus(input, {
                target: "server",
                mode: "cli",
                provider: input.provider,
                projectId: input.projectId,
                serverName: input.serverName!,
                status: "completed",
                startedAt: loginStatuses.get(loginStatusKey(input))?.startedAt ?? nowIso(),
                completedAt: nowIso(),
                ...(message ? { message } : {}),
              });
              yield* publishLoginCompletion({
                provider: input.provider,
                projectId: input.projectId,
                configVersion: stored.effectiveVersion,
              });
              runBackgroundCodexReloadAfterLogin({
                projectId: input.projectId,
                serverName: input.serverName!,
                ...(providerOptions ? { providerOptions } : {}),
                configVersion: stored.effectiveVersion,
              });
              return;
            }

            setLoginStatus(input, {
              target: "server",
              mode: "cli",
              provider: input.provider,
              projectId: input.projectId,
              serverName: input.serverName!,
              status: "failed",
              startedAt: loginStatuses.get(loginStatusKey(input))?.startedAt ?? nowIso(),
              completedAt: nowIso(),
              error: message ?? "Codex MCP login failed.",
            });
          }),
        ),
        Effect.catch((cause) =>
          Effect.logError("Failed to start Codex MCP login.", {
            cause,
            projectId: input.projectId,
            serverName: input.serverName!,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                setLoginStatus(input, {
                  target: "server",
                  mode: "cli",
                  provider: input.provider,
                  projectId: input.projectId,
                  serverName: input.serverName!,
                  status: "failed",
                  startedAt: loginStatuses.get(loginStatusKey(input))?.startedAt ?? nowIso(),
                  completedAt: nowIso(),
                  error:
                    cause instanceof Error ? cause.message : "Failed to start Codex MCP login.",
                });
              }),
            ),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );

      return yield* startCliLogin(input, {
        mode: "cli",
        effect: execute,
      });
    });

  const getLoginStatus: McpRuntimeServiceShape["getLoginStatus"] = (input) =>
    Effect.gen(function* () {
      if (input.provider === "codex" && input.serverName) {
        const { server } = yield* readStoredServer(input).pipe(
          Effect.catch(() => Effect.succeed({ stored: undefined, server: undefined })),
        );
        if (server && supportsCodexOauthLogin(server)) {
          const status = yield* codexOAuthManager.getStatus({
            projectId: input.projectId,
            serverName: input.serverName,
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            ...(input.homePath ? { homePath: input.homePath } : {}),
          });
          return {
            target: "server",
            mode: "oauth",
            provider: "codex",
            projectId: input.projectId,
            serverName: input.serverName,
            status: status.status,
            ...(status.authorizationUrl ? { authorizationUrl: status.authorizationUrl } : {}),
            ...(status.startedAt ? { startedAt: status.startedAt } : {}),
            ...(status.completedAt ? { completedAt: status.completedAt } : {}),
            ...(status.message ? { message: status.message } : {}),
            ...(status.error ? { error: status.error } : {}),
          } satisfies McpLoginStatusResult;
        }
      }

      const existing = loginStatuses.get(loginStatusKey(input));
      if (existing) {
        return existing;
      }

      return readIdleLoginStatus(input, "cli");
    });

  return {
    getProviderStatus,
    getServerStatuses,
    startLogin,
    getLoginStatus,
  } satisfies McpRuntimeServiceShape;
});

export const McpRuntimeServiceLive = Layer.effect(McpRuntimeService, makeMcpRuntimeService);
