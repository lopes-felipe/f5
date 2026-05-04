import {
  type McpOauthLoginStatusRequest,
  McpOauthLoginStatusResult,
  type McpStartOauthLoginRequest,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect, FiberSet, Layer, Schema, ServiceMap } from "effect";

import { combineStatusMessage } from "../mcp/combineStatusMessage.ts";
import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import { toCodexProviderStartOptions } from "../provider/codexProviderOptions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import type { CodexControlClient } from "./CodexControlClient.ts";
import { CodexControlClientRegistry } from "./CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./CodexMcpEventBus.ts";
import {
  codexServerNamesMatch,
  codexServerStatusHasAuthenticatedOauth,
  findCodexServerStatusByName,
  listAllCodexServerStatuses,
} from "./codexMcpServerStatus.ts";

const OAUTH_LOGIN_TIMEOUT_SEC = 300;
const OAUTH_RECONCILE_INTERVAL_MS = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function statusKeyFor(input: McpOauthLoginStatusRequest): string {
  return `${input.projectId}\u0000${input.binaryPath ?? ""}\u0000${input.homePath ?? ""}\u0000${input.serverName}`;
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
  readonly mcpEffectiveConfigVersion: string | null | undefined;
  readonly client: CodexControlClient;
  readonly release: Effect.Effect<void>;
  readonly cleanupNotificationListener: () => void;
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
      reason: "oauth-completed",
      ...(metadata.mcpEffectiveConfigVersion
        ? { configVersion: metadata.mcpEffectiveConfigVersion }
        : {}),
    });

  const runBackgroundReloadAfterLogin = (
    input: McpOauthLoginStatusRequest,
    metadata: PendingOAuthMetadata,
  ) =>
    runBackgroundTask(
      providerService
        .reloadMcpConfigForProject({
          provider: "codex",
          projectId: input.projectId,
          ...(metadata.providerOptions ? { providerOptions: metadata.providerOptions } : {}),
        })
        .pipe(
          Effect.as<string | undefined>(undefined),
          Effect.catch((cause) =>
            Effect.logWarning(
              "Codex MCP OAuth login succeeded but reloading live sessions failed.",
              {
                cause,
                projectId: input.projectId,
                serverName: input.serverName,
              },
            ).pipe(
              Effect.as(
                "Login completed, but reloading live Codex sessions failed. Apply the shared MCP config to live sessions to retry.",
              ),
            ),
          ),
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
        return statusByKey.get(key) ?? makeIdleStatus(input);
      }

      metadata.cleanupNotificationListener();
      const existingStatus = statusByKey.get(key);
      const nextStatus: McpOauthLoginStatusResult = {
        projectId: input.projectId,
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
      try: () => listAllCodexServerStatuses(metadata.client),
      catch: (cause) =>
        cause instanceof Error
          ? new CodexOAuthManagerError({ message: cause.message })
          : new CodexOAuthManagerError({
              message: "Failed to read Codex MCP server status during OAuth login reconciliation.",
            }),
    }).pipe(
      Effect.flatMap((statuses) => {
        const status = findCodexServerStatusByName(statuses, input.serverName);
        if (!codexServerStatusHasAuthenticatedOauth(status)) {
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
      if (metadata) {
        const reconciled = yield* reconcilePendingStatus(input, existing, metadata);
        if (reconciled.status !== "pending") {
          return reconciled;
        }
      }

      const hasLease = yield* registry.hasOauthLease({
        projectId: input.projectId,
        serverName: input.serverName,
        ...(metadata?.providerOptions ? { providerOptions: metadata.providerOptions } : {}),
        ...(metadata?.mcpEffectiveConfigVersion !== undefined
          ? { mcpEffectiveConfigVersion: metadata.mcpEffectiveConfigVersion }
          : {}),
      });
      if (hasLease) {
        return existing;
      }

      const expiredStatus = makeFailedStatus(input, {
        startedAt: existing.startedAt ?? nowIso(),
        error: "OAuth login timed out before completion.",
        ...(existing.authorizationUrl ? { authorizationUrl: existing.authorizationUrl } : {}),
      });
      metadata?.cleanupNotificationListener();
      statusByKey.set(key, expiredStatus);
      pendingMetadataByKey.delete(key);
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

        const startedAt = nowIso();
        const pendingStatus: McpOauthLoginStatusResult = {
          projectId: input.projectId,
          serverName: input.serverName,
          status: "pending",
          startedAt,
        };
        setStatus(input, pendingStatus);

        const lease = yield* registry
          .acquireOauthClient({
            projectId: input.projectId,
            serverName: input.serverName,
            ...(providerOptions ? { providerOptions } : {}),
            mcpEffectiveConfigVersion: stored.effectiveVersion,
            mcpServers: stored.servers,
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
                pendingMetadataByKey.delete(statusKeyFor(input));
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
        const pendingMetadata: PendingOAuthMetadata = {
          providerOptions,
          mcpEffectiveConfigVersion: stored.effectiveVersion,
          client: lease.client,
          release: lease.release,
          cleanupNotificationListener: () => {
            if (notificationListener) {
              lease.client.off("notification", notificationListener);
            }
          },
          nextReconcileAtMs: 0,
          reconcileInFlight: false,
        };
        pendingMetadataByKey.set(statusKeyFor(input), pendingMetadata);

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

        return yield* Effect.tryPromise({
          try: () =>
            lease.client.startOAuthLogin({
              name: input.serverName,
              timeoutSecs: OAUTH_LOGIN_TIMEOUT_SEC,
            }),
          catch: (cause) =>
            new CodexOAuthManagerError({
              message: cause instanceof Error ? cause.message : "Failed to start MCP OAuth login.",
            }),
        }).pipe(
          Effect.map((loginResult) => {
            const nextStatus: McpOauthLoginStatusResult = {
              projectId: input.projectId,
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
              lease.client.off("notification", notificationListener);
              const nextStatus = makeFailedStatus(input, {
                startedAt,
                error: error instanceof Error ? error.message : "Failed to start MCP OAuth login.",
              });
              setStatus(input, nextStatus);
              pendingMetadataByKey.delete(statusKeyFor(input));
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
