import { assertOAuthPortAvailable } from "../profiles/ProviderAccountService";
import {
  McpOauthLoginStatusResult,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { CODEX_MCP_OAUTH_LOGIN_TIMEOUT_SEC } from "@t3tools/shared/codexOAuthTiming";
import { Effect, FiberSet, Layer, Schema, ServiceMap } from "effect";

import { combineStatusMessage } from "../mcp/combineStatusMessage.ts";
import { codexAdminMcpConfig, makeNativeProvidersOnHub } from "../mcp/hub/nativeHubOptions.ts";
import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import { reloadCodexMcpConfigAfterLogin } from "../mcp/reloadCodexMcpConfigAfterLogin.ts";
import { toCodexProviderStartOptions } from "../provider/codexProviderOptions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { CodexControlClient } from "./CodexControlClient.ts";
import { CodexControlClientRegistry } from "./CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./CodexMcpEventBus.ts";
import {
  preflightCodexOAuthCallback,
  validateCodexOAuthCallbackConfig,
} from "./CodexOAuthCallbackPreflight.ts";
import {
  codexServerNamesMatch,
  codexServerStatusCanReconcileCompletedOauthLogin,
  findCodexServerStatusByName,
  listAllCodexServerStatuses,
} from "./codexMcpServerStatus.ts";

const OAUTH_RECONCILE_INTERVAL_MS = 5_000;

/**
 * Server-internal: McpRuntimeService builds this after resolving the account, so
 * the executable and home come from the provider instance, never from a client.
 */
export interface McpOauthLoginStatusRequest {
  readonly projectId: ProjectId;
  readonly serverName: string;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
}
export type McpStartOauthLoginRequest = McpOauthLoginStatusRequest;

function nowIso(): string {
  return new Date().toISOString();
}

function statusKeyFor(input: McpOauthLoginStatusRequest): string {
  return `${input.projectId}\u0000${input.instanceId ?? "codex"}\u0000${input.binaryPath ?? ""}\u0000${input.homePath ?? ""}\u0000${input.serverName}`;
}

function makeIdleStatus(input: McpOauthLoginStatusRequest): McpOauthLoginStatusResult {
  return {
    projectId: input.projectId,
    serverName: input.serverName,
    status: "idle",
  };
}

function makeFailedStatus(
  input: McpOauthLoginStatusRequest,
  details: {
    readonly startedAt: string;
    readonly error: string;
    readonly authorizationUrl?: string;
  },
): McpOauthLoginStatusResult {
  return {
    projectId: input.projectId,
    serverName: input.serverName,
    status: "failed",
    startedAt: details.startedAt,
    completedAt: nowIso(),
    error: details.error,
    ...(details.authorizationUrl ? { authorizationUrl: details.authorizationUrl } : {}),
  };
}

interface PendingOAuthMetadata {
  readonly providerOptions: ProviderStartOptions | undefined;
  /** The saved MCP config version the sign-in ran against, published on completion. */
  readonly configVersion: string;
  /** The admin client's pool key, which differs from `configVersion` on the hub. */
  readonly mcpEffectiveConfigVersion: string | null | undefined;
  readonly mcpOAuthCallbackPort: number | undefined;
  readonly mcpOAuthCallbackUrl: string | undefined;
  readonly client: CodexControlClient;
  readonly release: Effect.Effect<void>;
  readonly cleanupListeners: () => void;
  nextReconcileAtMs: number;
  reconcileInFlight: boolean;
}

export class CodexOAuthManagerError extends Schema.TaggedErrorClass<CodexOAuthManagerError>()(
  "CodexOAuthManagerError",
  {
    message: Schema.String,
  },
) {}

export interface CodexOAuthManagerShape {
  readonly startLogin: (
    input: McpStartOauthLoginRequest,
  ) => Effect.Effect<McpOauthLoginStatusResult, CodexOAuthManagerError>;
  readonly getStatus: (
    input: McpOauthLoginStatusRequest,
  ) => Effect.Effect<McpOauthLoginStatusResult>;
}

export class CodexOAuthManager extends ServiceMap.Service<
  CodexOAuthManager,
  CodexOAuthManagerShape
>()("t3/codex/CodexOAuthManager") {}

const makeCodexOAuthManager = Effect.gen(function* () {
  const registry = yield* CodexControlClientRegistry;
  const providerService = yield* ProviderService;
  const eventBus = yield* CodexMcpEventBus;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const nativeProvidersOnHub = yield* makeNativeProvidersOnHub;
  const runBackgroundTask = yield* FiberSet.makeRuntime<never>();
  const statusByKey = new Map<string, McpOauthLoginStatusResult>();
  const pendingMetadataByKey = new Map<string, PendingOAuthMetadata>();

  const setStatus = (input: McpOauthLoginStatusRequest, status: McpOauthLoginStatusResult) => {
    statusByKey.set(statusKeyFor(input), status);
  };

  const publishStatusUpdated = (
    input: McpOauthLoginStatusRequest,
    metadata: PendingOAuthMetadata,
  ) =>
    eventBus.publishStatusUpdated({
      provider: "codex",
      scope: "project",
      projectId: input.projectId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      reason: "oauth-completed",
      ...(metadata.configVersion ? { configVersion: metadata.configVersion } : {}),
    });

  const runBackgroundReloadAfterLogin = (
    input: McpOauthLoginStatusRequest,
    metadata: PendingOAuthMetadata,
  ) =>
    runBackgroundTask(
      reloadCodexMcpConfigAfterLogin({
        providerService,
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        serverName: input.serverName,
        ...(metadata.providerOptions ? { providerOptions: metadata.providerOptions } : {}),
      }).pipe(
        Effect.flatMap((reloadMessage) =>
          Effect.gen(function* () {
            if (reloadMessage) {
              const current = statusByKey.get(statusKeyFor(input));
              if (current?.status === "completed") {
                setStatus(input, {
                  ...current,
                  message: combineStatusMessage(current.message, reloadMessage),
                });
              }
            }

            yield* publishStatusUpdated(input, metadata);
          }),
        ),
        Effect.asVoid,
      ),
    );

  const finalizePendingStatus = (
    input: McpOauthLoginStatusRequest,
    metadata: PendingOAuthMetadata,
    payload: {
      readonly success: boolean;
      readonly error?: string;
      readonly message?: string;
    },
  ) =>
    Effect.gen(function* () {
      const key = statusKeyFor(input);
      if (pendingMetadataByKey.get(key) !== metadata) {
        metadata.cleanupListeners();
        return statusByKey.get(key) ?? makeIdleStatus(input);
      }

      metadata.cleanupListeners();
      const existingStatus = statusByKey.get(key);
      const nextStatus: McpOauthLoginStatusResult = {
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        serverName: input.serverName,
        status: payload.success ? "completed" : "failed",
        startedAt: existingStatus?.startedAt ?? nowIso(),
        completedAt: nowIso(),
        ...(payload.message ? { message: payload.message } : {}),
        ...(payload.error ? { error: payload.error } : {}),
        ...(existingStatus?.authorizationUrl
          ? { authorizationUrl: existingStatus.authorizationUrl }
          : {}),
      };

      statusByKey.set(key, nextStatus);
      pendingMetadataByKey.delete(key);
      yield* publishStatusUpdated(input, metadata);
      if (payload.success) {
        runBackgroundReloadAfterLogin(input, metadata);
      }
      return nextStatus;
    }).pipe(Effect.ensuring(metadata.release));

  const reconcilePendingStatus = (
    input: McpOauthLoginStatusRequest,
    existing: McpOauthLoginStatusResult,
    metadata: PendingOAuthMetadata,
  ) => {
    const key = statusKeyFor(input);
    const nowMs = Date.now();
    if (metadata.reconcileInFlight || nowMs < metadata.nextReconcileAtMs) {
      return Effect.succeed(existing);
    }

    metadata.reconcileInFlight = true;
    metadata.nextReconcileAtMs = nowMs + OAUTH_RECONCILE_INTERVAL_MS;

    return Effect.tryPromise({
      try: () => listAllCodexServerStatuses(metadata.client, input.serverName),
      catch: (cause) =>
        cause instanceof Error
          ? new CodexOAuthManagerError({ message: cause.message })
          : new CodexOAuthManagerError({
              message: "Failed to read Codex MCP server status during OAuth login reconciliation.",
            }),
    }).pipe(
      Effect.flatMap((statuses) => {
        const status = findCodexServerStatusByName(statuses, input.serverName);
        if (!codexServerStatusCanReconcileCompletedOauthLogin(status)) {
          return Effect.succeed(existing);
        }

        return finalizePendingStatus(input, metadata, {
          success: true,
        });
      }),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          if (pendingMetadataByKey.get(key) !== metadata) {
            return statusByKey.get(key) ?? existing;
          }

          yield* Effect.logWarning("Failed to reconcile pending Codex MCP OAuth login status.", {
            cause,
            projectId: input.projectId,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            serverName: input.serverName,
          });
          return existing;
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          metadata.reconcileInFlight = false;
        }),
      ),
    );
  };

  const readStatus = (input: McpOauthLoginStatusRequest) =>
    Effect.gen(function* () {
      const key = statusKeyFor(input);
      const existing = statusByKey.get(key);
      if (!existing || existing.status !== "pending") {
        return existing ?? makeIdleStatus(input);
      }

      const metadata = pendingMetadataByKey.get(key);
      if (!metadata) {
        // Status polling can observe the setup window before the OAuth lease exists.
        return existing;
      }

      const reconciled = yield* reconcilePendingStatus(input, existing, metadata);
      if (reconciled.status !== "pending") {
        return reconciled;
      }

      const hasLease = yield* registry.hasOauthLease({
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        serverName: input.serverName,
        ...(metadata?.providerOptions ? { providerOptions: metadata.providerOptions } : {}),
        ...(metadata?.mcpEffectiveConfigVersion !== undefined
          ? { mcpEffectiveConfigVersion: metadata.mcpEffectiveConfigVersion }
          : {}),
        ...(metadata?.mcpOAuthCallbackPort
          ? { mcpOAuthCallbackPort: metadata.mcpOAuthCallbackPort }
          : {}),
        ...(metadata?.mcpOAuthCallbackUrl
          ? { mcpOAuthCallbackUrl: metadata.mcpOAuthCallbackUrl }
          : {}),
      });
      if (hasLease) {
        return existing;
      }
      // The login finished (or a new one started) while reconciliation and the lease
      // check ran; the stored outcome wins over a timeout decided from stale reads.
      if (pendingMetadataByKey.get(key) !== metadata) {
        return statusByKey.get(key) ?? existing;
      }

      const expiredStatus = makeFailedStatus(input, {
        startedAt: existing.startedAt ?? nowIso(),
        error: "OAuth login timed out before completion.",
        ...(existing.authorizationUrl ? { authorizationUrl: existing.authorizationUrl } : {}),
      });
      metadata?.cleanupListeners();
      statusByKey.set(key, expiredStatus);
      pendingMetadataByKey.delete(key);
      yield* publishStatusUpdated(input, metadata);
      return expiredStatus;
    });

  return {
    startLogin: (input) =>
      Effect.gen(function* () {
        const existing = yield* readStatus(input);
        if (existing.status === "pending") {
          return existing;
        }

        const providerOptions = toCodexProviderStartOptions({
          binaryPath: input.binaryPath,
          homePath: input.homePath,
        });
        const stored = yield* projectMcpConfigService.readCodexServers(input.projectId).pipe(
          Effect.mapError(
            (error) =>
              new CodexOAuthManagerError({
                message: error.message,
              }),
          ),
        );
        // With the hub serving Codex, only Codex's own servers sign in here.
        const admin = codexAdminMcpConfig(stored, yield* nativeProvidersOnHub);

        const startedAt = nowIso();
        const key = statusKeyFor(input);
        const pendingStatus: McpOauthLoginStatusResult = {
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          serverName: input.serverName,
          status: "pending",
          startedAt,
        };
        setStatus(input, pendingStatus);

        const lease = yield* registry
          .acquireOauthClient({
            projectId: input.projectId,
            ...(input.instanceId ? { instanceId: input.instanceId } : {}),
            serverName: input.serverName,
            ...(providerOptions ? { providerOptions } : {}),
            ...admin,
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                setStatus(
                  input,
                  makeFailedStatus(input, {
                    startedAt,
                    error: error.message,
                  }),
                );
                pendingMetadataByKey.delete(key);
              }),
            ),
            Effect.mapError(
              (error) =>
                new CodexOAuthManagerError({
                  message: error.message,
                }),
            ),
          );

        let notificationListener:
          | ((input: { readonly method: string; readonly params?: unknown }) => void)
          | undefined;
        let closedListener: ((error: Error) => void) | undefined;
        const pendingMetadata: PendingOAuthMetadata = {
          providerOptions,
          configVersion: stored.effectiveVersion,
          mcpEffectiveConfigVersion: admin.mcpEffectiveConfigVersion,
          mcpOAuthCallbackPort: admin.mcpOAuthCallbackPort,
          mcpOAuthCallbackUrl: admin.mcpOAuthCallbackUrl,
          client: lease.client,
          release: lease.release,
          cleanupListeners: () => {
            if (notificationListener) {
              lease.client.off("notification", notificationListener);
            }
            if (closedListener) {
              lease.client.off("closed", closedListener);
            }
          },
          nextReconcileAtMs: 0,
          reconcileInFlight: false,
        };
        pendingMetadataByKey.set(statusKeyFor(input), pendingMetadata);
        // Nothing polls a pending sign-in any more: reconcile here until it settles, so a
        // completion Codex never announces still finishes (and publishes) on its own.
        runBackgroundTask(
          Effect.gen(function* () {
            while (pendingMetadataByKey.get(statusKeyFor(input)) === pendingMetadata) {
              yield* Effect.sleep(OAUTH_RECONCILE_INTERVAL_MS);
              if (pendingMetadataByKey.get(statusKeyFor(input)) !== pendingMetadata) return;
              yield* readStatus(input);
            }
          }),
        );

        notificationListener = ({
          method,
          params,
        }: {
          readonly method: string;
          readonly params?: unknown;
        }) => {
          if (method !== "mcpServer/oauthLogin/completed") {
            return;
          }
          const payload =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : undefined;
          const payloadName =
            typeof payload?.name === "string" && payload.name.trim().length > 0
              ? payload.name.trim()
              : undefined;
          if (payloadName && !codexServerNamesMatch(payloadName, input.serverName)) {
            runBackgroundTask(
              Effect.logWarning("Ignoring OAuth completion for unexpected MCP server name.", {
                projectId: input.projectId,
                ...(input.instanceId ? { instanceId: input.instanceId } : {}),
                expectedServerName: input.serverName,
                receivedServerName: payloadName,
              }),
            );
            return;
          }

          runBackgroundTask(
            finalizePendingStatus(input, pendingMetadata, {
              success: payload?.success === true,
              ...(typeof payload?.error === "string" && payload.error.trim().length > 0
                ? { error: payload.error.trim() }
                : {}),
            }).pipe(Effect.asVoid),
          );
        };

        lease.client.on("notification", notificationListener);

        closedListener = (error: Error) => {
          runBackgroundTask(
            finalizePendingStatus(input, pendingMetadata, {
              success: false,
              error:
                error.message.trim().length > 0
                  ? `Codex OAuth: ${error.message}`
                  : "Codex OAuth control client exited before login completed.",
            }).pipe(Effect.asVoid),
          );
        };
        lease.client.on("closed", closedListener);

        return yield* Effect.tryPromise({
          try: async () => {
            const callback = {
              ...(admin.mcpOAuthCallbackPort
                ? { mcpOAuthCallbackPort: admin.mcpOAuthCallbackPort }
                : {}),
              ...(admin.mcpOAuthCallbackUrl
                ? { mcpOAuthCallbackUrl: admin.mcpOAuthCallbackUrl }
                : {}),
            };
            validateCodexOAuthCallbackConfig(callback);
            if (admin.mcpOAuthCallbackPort)
              await assertOAuthPortAvailable(admin.mcpOAuthCallbackPort);
            const loginResult = await lease.client.startOAuthLogin({
              name: input.serverName,
              timeoutSecs: CODEX_MCP_OAUTH_LOGIN_TIMEOUT_SEC,
            });
            await preflightCodexOAuthCallback({
              authorizationUrl: loginResult.authorizationUrl,
              ...callback,
            });
            return loginResult;
          },
          catch: (cause) =>
            new CodexOAuthManagerError({
              message: cause instanceof Error ? cause.message : "Failed to start MCP OAuth login.",
            }),
        }).pipe(
          Effect.map((loginResult) => {
            if (pendingMetadataByKey.get(key) !== pendingMetadata) {
              return statusByKey.get(key) ?? makeIdleStatus(input);
            }
            const nextStatus: McpOauthLoginStatusResult = {
              projectId: input.projectId,
              ...(input.instanceId ? { instanceId: input.instanceId } : {}),
              serverName: input.serverName,
              status: "pending",
              startedAt,
              authorizationUrl: loginResult.authorizationUrl,
            };
            setStatus(input, nextStatus);
            return nextStatus;
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              pendingMetadata.cleanupListeners();
              if (pendingMetadataByKey.get(key) !== pendingMetadata) {
                return statusByKey.get(key) ?? makeIdleStatus(input);
              }
              const nextStatus = makeFailedStatus(input, {
                startedAt,
                error: error instanceof Error ? error.message : "Failed to start MCP OAuth login.",
              });
              setStatus(input, nextStatus);
              pendingMetadataByKey.delete(key);
              yield* lease.release;
              return yield* new CodexOAuthManagerError({
                message:
                  error instanceof Error ? error.message : "Failed to start MCP OAuth login.",
              });
            }),
          ),
        );
      }),
    getStatus: (input) => readStatus(input),
  } satisfies CodexOAuthManagerShape;
});

export const CodexOAuthManagerLive = Layer.effect(CodexOAuthManager, makeCodexOAuthManager);
