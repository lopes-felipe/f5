import type {
  McpCodexStatusResult,
  McpCommonConfigResult,
  McpEffectiveConfigResult,
  McpOauthLoginStatusResult,
  McpProjectConfigResult,
  ProjectId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

type CodexEnvironmentKeyPart = string | null;

export const mcpQueryKeys = {
  all: ["mcp"] as const,
  commonConfig: () => ["mcp", "commonConfig"] as const,
  projectConfig: (projectId: ProjectId | null) => ["mcp", "projectConfig", projectId] as const,
  effectiveConfig: (projectId: ProjectId | null) => ["mcp", "effectiveConfig", projectId] as const,
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
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
}) {
  return queryOptions<McpCodexStatusResult>({
    queryKey: mcpQueryKeys.codexStatus(
      input.projectId,
      input.binaryPath ?? null,
      input.homePath ?? null,
    ),
    enabled: (input.enabled ?? true) && Boolean(input.projectId),
    queryFn: async () => {
      if (!input.projectId) {
        throw new Error("Codex MCP status is unavailable.");
      }
      return ensureNativeApi().mcp.getCodexStatus({
        projectId: input.projectId,
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    },
  });
}

export function mcpOAuthStatusQueryOptions(input: {
  readonly projectId: ProjectId | null;
  readonly serverName: string | null;
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly enabled?: boolean;
  readonly refetchInterval?: number | false;
}) {
  return queryOptions<McpOauthLoginStatusResult>({
    queryKey: mcpQueryKeys.oauthStatus(
      input.projectId,
      input.serverName,
      input.binaryPath ?? null,
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
        serverName: input.serverName,
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    },
  });
}
