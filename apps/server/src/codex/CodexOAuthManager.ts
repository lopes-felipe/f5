import {
  type McpOauthLoginStatusRequest,
  McpOauthLoginStatusResult,
  type McpStartOauthLoginRequest,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { ProjectMcpConfigService } from "../mcp/ProjectMcpConfigService.ts";
import { toCodexProviderStartOptions } from "../provider/codexProviderOptions.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { CodexControlClientRegistry } from "./CodexControlClientRegistry.ts";
import { CodexMcpEventBus } from "./CodexMcpEventBus.ts";
import { CodexMcpSyncService } from "./CodexMcpSyncService.ts";

const OAUTH_LOGIN_TIMEOUT_SEC = 300;

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
  const syncService = yield* CodexMcpSyncService;
  const providerService = yield* ProviderService;
  const eventBus = yield* CodexMcpEventBus;
  const projectMcpConfigService = yield* ProjectMcpConfigService;
  const statusByKey = new Map<string, McpOauthLoginStatusResult>();
  const pendingMetadataByKey = new Map<string, PendingOAuthMetadata>();

  const setStatus = (input: McpOauthLoginStatusRequest, status: McpOauthLoginStatusResult) => {
    statusByKey.set(statusKeyFor(input), status);
  };

  const readStatus = (input: McpOauthLoginStatusRequest) =>
    Effect.gen(function* () {
      const key = statusKeyFor(input);
      const existing = statusByKey.get(key);
      if (!existing || existing.status !== "pending") {
        return existing ?? makeIdleStatus(input);
      }

      const metadata = pendingMetadataByKey.get(key);
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
        pendingMetadataByKey.set(statusKeyFor(input), {
          providerOptions,
          mcpEffectiveConfigVersion: stored.effectiveVersion,
        });

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

        const finalize = (payload: { readonly success: boolean; readonly error?: string }) =>
          Effect.gen(function* () {
            const completedAt = nowIso();
            const existingStatus = statusByKey.get(statusKeyFor(input));
            const nextStatus: McpOauthLoginStatusResult = {
              projectId: input.projectId,
              serverName: input.serverName,
              status: payload.success ? "completed" : "failed",
              startedAt,
              completedAt,
              ...(payload.error ? { error: payload.error } : {}),
              ...(existingStatus?.authorizationUrl
                ? { authorizationUrl: existingStatus.authorizationUrl }
                : {}),
            };
            statusByKey.set(statusKeyFor(input), nextStatus);
            pendingMetadataByKey.delete(statusKeyFor(input));

            if (payload.success) {
              yield* providerService
                .reloadMcpConfigForProject({
                  provider: "codex",
                  projectId: input.projectId,
                  ...(providerOptions ? { providerOptions } : {}),
                })
                .pipe(Effect.catch(() => Effect.void));
            }

            const status = yield* syncService.getStatus({
              projectId: input.projectId,
              ...(providerOptions ? { providerOptions } : {}),
            });
            yield* eventBus.publishStatusUpdated({
              provider: "codex",
              scope: "project",
              projectId: input.projectId,
              reason: "oauth-completed",
              ...(status.configVersion ? { configVersion: status.configVersion } : {}),
            });
          }).pipe(Effect.ensuring(lease.release));

        const notificationListener = ({
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
          if (payloadName && payloadName !== input.serverName) {
            return;
          }

          lease.client.off("notification", notificationListener);
          void Effect.runPromise(
            finalize({
              success: payload?.success === true,
              ...(typeof payload?.error === "string" && payload.error.trim().length > 0
                ? { error: payload.error.trim() }
                : {}),
            }),
          ).catch(() => undefined);
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
