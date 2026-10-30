import type {
  McpCodexStatusResult,
  ThreadId,
  McpStatusUpdatedPayload,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpLoginStatusResult,
  McpProviderStatusResult,
  McpOauthLoginStatusResult,
  McpProjectConfigResult,
  McpServerStatusesResult,
  ProjectId,
  ProviderKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { getWsConnectionState } from "../wsConnectionState";
import { ensureNativeApi } from "../nativeApi";
import { rpcQueryContext, rpcQueryMeta } from "./rpcQueryContext";

type CodexEnvironmentKeyPart = string | null;

export const mcpQueryKeys = {
  all: ["mcp"] as const,
  commonConfig: () => ["mcp", "commonConfig"] as const,
  projectConfig: (projectId: ProjectId | null) => ["mcp", "projectConfig", projectId] as const,
  effectiveConfig: (projectId: ProjectId | null) => ["mcp", "effectiveConfig", projectId] as const,
  providerStatus: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    binaryPath: CodexEnvironmentKeyPart,
    homePath: CodexEnvironmentKeyPart,
  ) => ["mcp", "providerStatus", provider, projectId, binaryPath, homePath] as const,
  serverStatuses: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    binaryPath: CodexEnvironmentKeyPart,
    homePath: CodexEnvironmentKeyPart,
  ) => ["mcp", "serverStatuses", provider, projectId, binaryPath, homePath] as const,
  loginStatus: (
    provider: ProviderKind,
    projectId: ProjectId | null,
    serverName: string | null,
    binaryPath: CodexEnvironmentKeyPart,
    homePath: CodexEnvironmentKeyPart,
  ) => ["mcp", "loginStatus", provider, projectId, serverName, binaryPath, homePath] as const,
  codexStatus: (
    projectId: ProjectId | null,
    binaryPath: CodexEnvironmentKeyPart,
    homePath: CodexEnvironmentKeyPart,
  ) => ["mcp", "codexStatus", projectId, binaryPath, homePath] as const,
  oauthStatus: (
    projectId: ProjectId | null,
    serverName: string | null,
    binaryPath: CodexEnvironmentKeyPart,
    homePath: CodexEnvironmentKeyPart,
  ) => ["mcp", "oauthStatus", projectId, serverName, binaryPath, homePath] as const,
};

/** Scoped account events must never refresh another account's control or login queries. */
export function isMcpQueryAffected(
  queryKey: readonly unknown[],
  event: McpStatusUpdatedPayload,
): boolean {
  if (queryKey[0] !== "mcp") return false;
  const kind = queryKey[1];
  const accountScoped = [
    "providerStatus",
    "serverStatuses",
    "inspectServer",
    "loginStatus",
    "codexStatus",
    "oauthStatus",
  ].includes(String(kind));
  if (event.instanceId) {
    if (!accountScoped) return false;
    const instance = queryKey[kind === "codexStatus" ? 3 : kind === "loginStatus" ? 5 : 4];
    if (instance !== event.instanceId) return false;
  }
  if (event.projectId && event.scope === "project") {
    const project =
      queryKey[accountScoped && kind !== "codexStatus" && kind !== "oauthStatus" ? 3 : 2];
    if (kind !== "commonConfig" && project !== event.projectId) return false;
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

export function mcpCodexStatusQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpCodexStatusResult>({
    queryKey: mcpQueryKeys.codexStatus(
      input.projectId,
      input.instanceId ?? input.binaryPath ?? null,
      input.homePath ?? null,
    ),
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    meta: rpcQueryMeta("refresh-background"),
    queryFn: async (context) => {
      if (!input.projectId) {
        throw new Error("Codex MCP status is unavailable.");
      }
      return ensureNativeApi().mcp.getCodexStatus(
        {
          projectId: input.projectId,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        },
        rpcQueryContext(context),
      );
    },
  });
}

export function mcpProviderStatusQueryOptions(input: {
  readonly provider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpProviderStatusResult>({
    queryKey: mcpQueryKeys.providerStatus(
      input.provider,
      input.projectId,
      input.instanceId ?? input.binaryPath ?? null,
      input.homePath ?? null,
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

export function mcpServerStatusesQueryOptions(input: {
  readonly provider: ProviderKind;
  readonly projectId: ProjectId | null;
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
  readonly threadId?: ThreadId;
  readonly fingerprint?: string;
  readonly generation?: number;
  readonly desiredVersion?: string;
  readonly appliedVersion?: string;
}) {
  return queryOptions<McpServerStatusesResult>({
    queryKey: [
      ...mcpQueryKeys.serverStatuses(
        input.provider,
        input.projectId,
        input.instanceId ?? input.binaryPath ?? null,
        input.homePath ?? null,
      ),
      input.threadId ? "conversation" : "automatic",
      input.fingerprint ?? null,
      input.threadId ?? null,
      input.generation ?? null,
      input.desiredVersion ?? null,
      input.appliedVersion ?? null,
    ],
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key?.[2] === input.provider &&
        key[3] === input.projectId &&
        key[4] === (input.instanceId ?? input.binaryPath ?? null) &&
        key[5] === (input.homePath ?? null) &&
        key[8] === (input.threadId ?? null)
        ? previous
        : undefined;
    },
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    refetchInterval: (query) => {
      if (!query.state.data?.statuses.some((server) => server.state === "starting")) {
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
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpLoginStatusResult>({
    queryKey: mcpQueryKeys.loginStatus(
      input.provider,
      input.projectId,
      input.serverName ?? null,
      input.instanceId ?? input.binaryPath ?? null,
      input.homePath ?? null,
    ),
    enabled:
      (input.enabled ?? true) &&
      Boolean(input.projectId) &&
      (input.provider === "claudeAgent" || Boolean(input.serverName)),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2_000 : false),
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

export function mcpOAuthStatusQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly serverName: string | null;
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
  readonly refetchInterval?: number | false;
}) {
  return queryOptions<McpOauthLoginStatusResult>({
    queryKey: mcpQueryKeys.oauthStatus(
      input.projectId,
      input.serverName,
      input.instanceId ?? input.binaryPath ?? null,
      input.homePath ?? null,
    ),
    enabled: (input.enabled ?? true) && Boolean(input.projectId) && Boolean(input.serverName),
    refetchInterval: input.refetchInterval ?? false,
    queryFn: async () => {
      if (!input.projectId || !input.serverName) {
        throw new Error("MCP OAuth status is unavailable.");
      }
      return ensureNativeApi().mcp.getOAuthStatus({
        projectId: input.projectId,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        serverName: input.serverName,
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
