import type {
  ThreadId,
  McpStatusUpdatedPayload,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpGetHubAuthStatusResult,
  McpGetHubStatusResult,
  McpLoginStatusResult,
  McpProviderStatusResult,
  McpProjectConfigResult,
  McpServerStatusesResult,
  ProjectId,
  ProviderKind,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { getWsConnectionState } from "../wsConnectionState";
import { ensureNativeApi } from "../nativeApi";
import { rpcQueryContext, rpcQueryMeta } from "./rpcQueryContext";

/**
 * Every MCP query key is `["mcp", kind, scope, ...extra]`. Event matching reads the
 * scope by name, and TanStack's partial matching lets a shorter scope (for example
 * without `threadId`) invalidate every query inside it.
 */
export interface McpQueryScope {
  readonly projectId: ProjectId | null;
  readonly provider?: ProviderKind | undefined;
  readonly instanceId?: ProviderInstanceId | null;
  readonly serverName?: string | null;
  readonly threadId?: ThreadId | null;
}

export function readMcpQueryScope(queryKey: readonly unknown[]): McpQueryScope | undefined {
  const scope = queryKey[2];
  return scope && typeof scope === "object" ? (scope as McpQueryScope) : undefined;
}

export const mcpQueryKeys = {
  all: ["mcp"] as const,
  commonConfig: () => ["mcp", "commonConfig", { projectId: null }] as const,
  projectConfig: (projectId: ProjectId | null) => ["mcp", "projectConfig", { projectId }] as const,
  effectiveConfig: (projectId: ProjectId | null) =>
    ["mcp", "effectiveConfig", { projectId }] as const,
  providerStatus: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    instanceId: ProviderInstanceId | null,
  ) => ["mcp", "providerStatus", { provider, projectId, instanceId }] as const,
  serverStatuses: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    instanceId: ProviderInstanceId | null,
  ) => ["mcp", "serverStatuses", { provider, projectId, instanceId }] as const,
  loginStatus: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    serverName: string | null,
    instanceId: ProviderInstanceId | null,
  ) => ["mcp", "loginStatus", { provider, projectId, serverName, instanceId }] as const,
  inspectServer: (
    provider: ProviderKind | undefined,
    projectId: ProjectId | null,
    instanceId: ProviderInstanceId | null,
    serverName: string,
    threadId: ThreadId | null,
  ) => ["mcp", "inspectServer", { provider, projectId, instanceId, serverName, threadId }] as const,
  hubStatus: (projectId: ProjectId | null) => ["mcp", "hubStatus", { projectId }] as const,
  hubAuth: (projectId: ProjectId | null) => ["mcp", "hubAuth", { projectId }] as const,
};

/** Sign-in state follows saves (the server list) and hub events (sign-in, sign-out). */
export function mcpHubAuthQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpGetHubAuthStatusResult>({
    queryKey: mcpQueryKeys.hubAuth(input.projectId),
    enabled: input.enabled ?? true,
    meta: rpcQueryMeta("refresh-background"),
    queryFn: async (context) =>
      ensureNativeApi().mcp.getHubAuthStatus(
        input.projectId ? { projectId: input.projectId } : {},
        rpcQueryContext(context),
      ),
  });
}

/** Hub status is pushed (reason `hub`), so it is never polled. */
export function mcpHubStatusQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpGetHubStatusResult>({
    queryKey: mcpQueryKeys.hubStatus(input.projectId),
    enabled: input.enabled ?? true,
    meta: rpcQueryMeta("refresh-background"),
    queryFn: async (context) =>
      ensureNativeApi().mcp.getHubStatus(
        input.projectId ? { projectId: input.projectId } : {},
        rpcQueryContext(context),
      ),
  });
}

const MCP_CONFIG_QUERY_KINDS = new Set(["commonConfig", "projectConfig", "effectiveConfig"]);

export function isMcpConfigQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "mcp" && MCP_CONFIG_QUERY_KINDS.has(String(queryKey[1]));
}

/**
 * A save changes stored configuration only. Statuses are refetched on Refresh,
 * Apply or a status event, because a Codex status check can start a provider
 * process that launches every configured server.
 */
export function invalidateMcpConfigQueries(
  queryClient: import("@tanstack/react-query").QueryClient,
) {
  return queryClient.invalidateQueries({
    queryKey: mcpQueryKeys.all,
    predicate: (query) => isMcpConfigQuery(query.queryKey),
  });
}

/** Scoped account events must never refresh another account's control or login queries. */
export function isMcpQueryAffected(
  queryKey: readonly unknown[],
  event: McpStatusUpdatedPayload,
): boolean {
  if (queryKey[0] !== "mcp") return false;
  const kind = queryKey[1];
  // Hub sign-in is profile-wide and local to read; provider-account events never change it.
  if (kind === "hubAuth") return event.instanceId === undefined;
  if (event.reason === "updated" && !isMcpConfigQuery(queryKey)) return false;
  // Hub connection changes never touch provider observations, and vice versa.
  if (event.reason === "hub") return kind === "hubStatus";
  if (kind === "hubStatus") return event.reason !== "updated";
  const accountScoped = [
    "providerStatus",
    "serverStatuses",
    "inspectServer",
    "loginStatus",
  ].includes(String(kind));
  const scope = readMcpQueryScope(queryKey);
  if (event.instanceId) {
    if (!accountScoped || scope?.instanceId !== event.instanceId) return false;
  }
  if (event.projectId && event.scope === "project") {
    if (kind !== "commonConfig" && scope?.projectId !== event.projectId) return false;
  }
  return true;
}

export function mcpCommonConfigQueryOptions(input?: { readonly enabled?: boolean }) {
  return queryOptions<McpCommonConfigResult>({
    queryKey: mcpQueryKeys.commonConfig(),
    enabled: input?.enabled ?? true,
    queryFn: async () => ensureNativeApi().mcp.getCommonConfig({}),
  });
}

export function mcpProjectConfigQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpProjectConfigResult>({
    queryKey: mcpQueryKeys.projectConfig(input.projectId),
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    queryFn: async () => {
      if (!input.projectId) {
        throw new Error("MCP project configuration is unavailable.");
      }
      return ensureNativeApi().mcp.getProjectConfig({
        projectId: input.projectId,
      });
    },
  });
}

export function mcpEffectiveConfigQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpEffectiveConfigResult>({
    queryKey: mcpQueryKeys.effectiveConfig(input.projectId),
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    queryFn: async () => {
      if (!input.projectId) {
        throw new Error("Effective MCP configuration is unavailable.");
      }
      return ensureNativeApi().mcp.getEffectiveConfig({
        projectId: input.projectId,
      });
    },
  });
}

export function mcpProviderStatusQueryOptions(input: {
  readonly provider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly instanceId?: ProviderInstanceId;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpProviderStatusResult>({
    queryKey: mcpQueryKeys.providerStatus(
      input.provider,
      input.projectId,
      input.instanceId ?? null,
    ),
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    meta: rpcQueryMeta("refresh-background"),
    queryFn: async (context) => {
      if (!input.projectId) {
        throw new Error("MCP provider status is unavailable.");
      }
      return ensureNativeApi().mcp.getProviderStatus(
        {
          provider: input.provider,
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        },
        rpcQueryContext(context),
      );
    },
  });
}

/**
 * The key deliberately omits the saved config version: a save must not refetch
 * statuses (see invalidateMcpConfigQueries).
 */
export function mcpServerStatusesQueryOptions(input: {
  readonly provider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly instanceId?: ProviderInstanceId;
  readonly enabled?: boolean;
  readonly threadId?: ThreadId;
}) {
  const scope: McpQueryScope = {
    provider: input.provider,
    projectId: input.projectId,
    instanceId: input.instanceId ?? null,
    threadId: input.threadId ?? null,
  };
  return queryOptions<McpServerStatusesResult>({
    queryKey: ["mcp", "serverStatuses", scope],
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery ? readMcpQueryScope(previousQuery.queryKey) : undefined;
      return key !== undefined &&
        key.provider === scope.provider &&
        key.projectId === scope.projectId &&
        key.instanceId === scope.instanceId &&
        key.threadId === scope.threadId
        ? previous
        : undefined;
    },
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    // Conversation statuses are pushed (reason `runtime`). A configuration check has no
    // conversation to report from, so its starting servers are re-checked for 30 seconds.
    refetchInterval: (query) => {
      if (
        !query.state.data ||
        query.state.data.source === "conversation" ||
        !query.state.data.statuses.some((server) => server.state === "starting")
      ) {
        runtimePollWindows.delete(query);
        return false;
      }
      const started = runtimePollWindows.get(query) ?? Date.now();
      runtimePollWindows.set(query, started);
      return shouldPollMcpRuntime(query.state.data, started) ? 2_000 : false;
    },
    meta: rpcQueryMeta("refresh-background"),
    queryFn: async (context) => {
      if (!input.projectId) {
        throw new Error("MCP server statuses are unavailable.");
      }
      return ensureNativeApi().mcp.getServerStatuses(
        {
          provider: input.provider,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        },
        rpcQueryContext(context),
      );
    },
  });
}

export function mcpLoginStatusQueryOptions(input: {
  readonly provider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly serverName?: string | null;
  readonly instanceId?: ProviderInstanceId;
  readonly enabled?: boolean;
}) {
  // The server records a Claude server sign-in under the provider's default instance when
  // none is given, and pushes its completion with that instance; the key must match it.
  const instanceId =
    input.instanceId ??
    (input.provider === "claudeAgent" && input.serverName
      ? ProviderInstanceId.make(input.provider)
      : undefined);
  return queryOptions<McpLoginStatusResult>({
    queryKey: mcpQueryKeys.loginStatus(
      input.provider,
      input.projectId,
      input.serverName ?? null,
      instanceId ?? null,
    ),
    enabled:
      (input.enabled ?? true) &&
      Boolean(input.projectId) &&
      (input.provider === "claudeAgent" || Boolean(input.serverName)),
    // Not polled: every completed or failed sign-in is pushed (see useMcpStatusUpdates).
    queryFn: async () => {
      if (!input.projectId) {
        throw new Error("MCP login status is unavailable.");
      }
      return ensureNativeApi().mcp.getLoginStatus({
        provider: input.provider,
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.serverName ? { serverName: input.serverName } : {}),
      });
    },
  });
}

const runtimePollWindows = new WeakMap<object, number>();

// The poll budget is per identity, and is not extended by each successful refresh.
export function shouldPollMcpRuntime(
  data: McpServerStatusesResult | undefined,
  startedAt: number,
  now = Date.now(),
): boolean {
  return (
    getWsConnectionState().phase === "connected" &&
    Boolean(data?.statuses.some((server) => server.state === "starting")) &&
    now - startedAt < 30_000
  );
}

export function resetMcpRuntimePolling(queryClient: import("@tanstack/react-query").QueryClient) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: mcpQueryKeys.all }))
    runtimePollWindows.delete(query);
}
