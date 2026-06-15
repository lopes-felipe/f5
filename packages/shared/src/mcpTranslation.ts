import type {
  ClaudeAgentMcpServerConfig,
  CodexMcpServerEntry,
  McpProjectServersConfig,
  McpServerDefinition,
} from "@t3tools/contracts";
import {
  normalizeOptionalString,
  normalizeOptionalStringArray,
  normalizeStringRecord,
} from "./mcpNormalization";

type McpServerEntry = readonly [string, McpServerDefinition];

export class CodexMcpOAuthCallbackPortConflictError extends Error {
  readonly ports: ReadonlyArray<{
    readonly serverName: string;
    readonly port: number;
  }>;

  constructor(
    ports: ReadonlyArray<{
      readonly serverName: string;
      readonly port: number;
    }>,
  ) {
    const formattedPorts = ports.map(({ serverName, port }) => `${serverName}:${port}`).join(", ");
    super(
      `Codex MCP OAuth callback port must be the same for all enabled servers because Codex accepts a single process-level mcp_oauth_callback_port. Found conflicting ports: ${formattedPorts}.`,
    );
    this.name = "CodexMcpOAuthCallbackPortConflictError";
    this.ports = ports;
  }
}

export class CodexMcpOAuthCallbackUrlConflictError extends Error {
  readonly urls: ReadonlyArray<{
    readonly serverName: string;
    readonly url: string;
  }>;

  constructor(
    urls: ReadonlyArray<{
      readonly serverName: string;
      readonly url: string;
    }>,
  ) {
    const formattedUrls = urls.map(({ serverName, url }) => `${serverName}:${url}`).join(", ");
    super(
      `Codex MCP OAuth callback URL must be the same for all enabled servers because Codex accepts a single process-level mcp_oauth_callback_url. Found conflicting URLs: ${formattedUrls}.`,
    );
    this.name = "CodexMcpOAuthCallbackUrlConflictError";
    this.urls = urls;
  }
}

export interface CodexMcpOAuthCallbackConfig {
  readonly port?: number;
  readonly url?: string;
}

function normalizeMcpEntryName(value: string): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > 128) {
    return undefined;
  }
  return normalized;
}

function normalizeCommonEntry(entry: McpServerDefinition): {
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly bearerTokenEnvVar?: string;
  readonly supportsParallelToolCalls?: boolean;
  readonly startupTimeoutSec?: number;
  readonly toolTimeoutSec?: number;
  readonly enabledTools?: string[];
  readonly disabledTools?: string[];
  readonly scopes?: string[];
  readonly oauthClientId?: string;
  readonly oauthCallbackPort?: number;
  readonly oauthCallbackUrl?: string;
  readonly oauthResource?: string;
} {
  return {
    ...(normalizeOptionalString(entry.command)
      ? { command: normalizeOptionalString(entry.command)! }
      : {}),
    ...(normalizeOptionalStringArray(entry.args)
      ? { args: normalizeOptionalStringArray(entry.args)! }
      : {}),
    ...(normalizeStringRecord(entry.env) ? { env: normalizeStringRecord(entry.env)! } : {}),
    ...(normalizeOptionalString(entry.cwd) ? { cwd: normalizeOptionalString(entry.cwd)! } : {}),
    ...(normalizeOptionalString(entry.url) ? { url: normalizeOptionalString(entry.url)! } : {}),
    ...(normalizeStringRecord(entry.headers)
      ? { headers: normalizeStringRecord(entry.headers)! }
      : {}),
    ...(normalizeOptionalString(entry.bearerTokenEnvVar)
      ? { bearerTokenEnvVar: normalizeOptionalString(entry.bearerTokenEnvVar)! }
      : {}),
    ...(typeof entry.supportsParallelToolCalls === "boolean"
      ? { supportsParallelToolCalls: entry.supportsParallelToolCalls }
      : {}),
    ...(typeof entry.startupTimeoutSec === "number" && Number.isInteger(entry.startupTimeoutSec)
      ? { startupTimeoutSec: entry.startupTimeoutSec }
      : {}),
    ...(typeof entry.toolTimeoutSec === "number" && Number.isInteger(entry.toolTimeoutSec)
      ? { toolTimeoutSec: entry.toolTimeoutSec }
      : {}),
    ...(normalizeOptionalStringArray(entry.enabledTools)
      ? { enabledTools: normalizeOptionalStringArray(entry.enabledTools)! }
      : {}),
    ...(normalizeOptionalStringArray(entry.disabledTools)
      ? { disabledTools: normalizeOptionalStringArray(entry.disabledTools)! }
      : {}),
    ...(normalizeOptionalStringArray(entry.scopes)
      ? { scopes: normalizeOptionalStringArray(entry.scopes)! }
      : {}),
    ...(normalizeOptionalString(entry.oauthClientId)
      ? { oauthClientId: normalizeOptionalString(entry.oauthClientId)! }
      : {}),
    ...(typeof entry.oauthCallbackPort === "number" &&
    Number.isInteger(entry.oauthCallbackPort) &&
    entry.oauthCallbackPort > 0 &&
    entry.oauthCallbackPort <= 65535
      ? { oauthCallbackPort: entry.oauthCallbackPort }
      : {}),
    ...(normalizeOptionalString(entry.oauthCallbackUrl)
      ? { oauthCallbackUrl: normalizeOptionalString(entry.oauthCallbackUrl)! }
      : {}),
    ...(normalizeOptionalString(entry.oauthResource)
      ? { oauthResource: normalizeOptionalString(entry.oauthResource)! }
      : {}),
  };
}

function toEntries(servers: McpProjectServersConfig | null | undefined): McpServerEntry[] {
  if (!servers) {
    return [];
  }
  return Object.entries(servers)
    .map(([name, definition]) => {
      const normalizedName = normalizeMcpEntryName(name);
      if (!normalizedName || !definition || typeof definition !== "object") {
        return null;
      }
      return [normalizedName, definition] as const;
    })
    .filter((entry): entry is McpServerEntry => entry !== null);
}

export function filterEnabledMcpServers(
  servers: McpProjectServersConfig | null | undefined,
): Record<string, McpServerDefinition> {
  return Object.fromEntries(
    toEntries(servers).filter(([, definition]) => definition.enabled !== false),
  );
}

export function translateMcpForClaudeAgent(
  servers: McpProjectServersConfig | null | undefined,
): Record<string, ClaudeAgentMcpServerConfig> | undefined {
  const translated: Record<string, ClaudeAgentMcpServerConfig> = {};
  for (const [name, definition] of Object.entries(filterEnabledMcpServers(servers))) {
    const normalized = normalizeCommonEntry(definition);
    if (definition.type === "stdio") {
      if (!normalized.command) {
        continue;
      }
      translated[name] = {
        type: "stdio",
        command: normalized.command,
        ...(normalized.args ? { args: normalized.args } : {}),
        ...(normalized.env ? { env: normalized.env } : {}),
        ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
      };
      continue;
    }
    if (!normalized.url) {
      continue;
    }
    translated[name] = {
      type: definition.type,
      url: normalized.url,
      ...(normalized.headers ? { headers: normalized.headers } : {}),
    };
  }

  return Object.keys(translated).length > 0 ? translated : undefined;
}

export function translateMcpForCodex(
  servers: McpProjectServersConfig | null | undefined,
): Record<string, CodexMcpServerEntry> | undefined {
  const translated: Record<string, CodexMcpServerEntry> = {};
  for (const [name, definition] of Object.entries(filterEnabledMcpServers(servers))) {
    const normalized = normalizeCommonEntry(definition);
    const shared = {
      ...(normalized.bearerTokenEnvVar
        ? { bearer_token_env_var: normalized.bearerTokenEnvVar }
        : {}),
      ...(typeof normalized.supportsParallelToolCalls === "boolean"
        ? { supports_parallel_tool_calls: normalized.supportsParallelToolCalls }
        : {}),
      ...(normalized.startupTimeoutSec !== undefined
        ? { startup_timeout_sec: normalized.startupTimeoutSec }
        : {}),
      ...(normalized.toolTimeoutSec !== undefined
        ? { tool_timeout_sec: normalized.toolTimeoutSec }
        : {}),
      ...(normalized.enabledTools ? { enabled_tools: normalized.enabledTools } : {}),
      ...(normalized.disabledTools ? { disabled_tools: normalized.disabledTools } : {}),
      ...(normalized.scopes ? { scopes: normalized.scopes } : {}),
      ...(normalized.oauthClientId
        ? {
            oauth: {
              client_id: normalized.oauthClientId,
            },
          }
        : {}),
      ...(normalized.oauthResource ? { oauth_resource: normalized.oauthResource } : {}),
    };

    if (definition.type === "stdio") {
      if (!normalized.command) {
        continue;
      }
      translated[name] = {
        type: "stdio",
        command: normalized.command,
        ...(normalized.args ? { args: normalized.args } : {}),
        ...(normalized.env ? { env: normalized.env } : {}),
        ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
        ...shared,
      };
      continue;
    }

    if (!normalized.url) {
      continue;
    }
    translated[name] = {
      type: definition.type,
      url: normalized.url,
      ...(normalized.headers ? { headers: normalized.headers } : {}),
      ...shared,
    };
  }

  return Object.keys(translated).length > 0 ? translated : undefined;
}

export function readCodexMcpOAuthCallbackPort(
  servers: McpProjectServersConfig | null | undefined,
): number | undefined {
  const ports = readCodexMcpOAuthCallbackPorts(servers);
  const uniquePorts = new Set(ports.map(({ port }) => port));
  if (uniquePorts.size > 1) {
    throw new CodexMcpOAuthCallbackPortConflictError(ports);
  }
  return ports[0]?.port;
}

export function readCodexMcpOAuthCallbackUrl(
  servers: McpProjectServersConfig | null | undefined,
): string | undefined {
  const urls = readCodexMcpOAuthCallbackUrls(servers);
  const uniqueUrls = new Set(urls.map(({ url }) => url));
  if (uniqueUrls.size > 1) {
    throw new CodexMcpOAuthCallbackUrlConflictError(urls);
  }
  return urls[0]?.url;
}

function readCodexMcpOAuthCallbackPorts(
  servers: McpProjectServersConfig | null | undefined,
): Array<{ readonly serverName: string; readonly port: number }> {
  const ports: Array<{ readonly serverName: string; readonly port: number }> = [];
  for (const [serverName, definition] of Object.entries(filterEnabledMcpServers(servers))) {
    const normalized = normalizeCommonEntry(definition);
    if (normalized.oauthCallbackPort !== undefined) {
      ports.push({ serverName, port: normalized.oauthCallbackPort });
    }
  }
  return ports;
}

function readCodexMcpOAuthCallbackUrls(
  servers: McpProjectServersConfig | null | undefined,
): Array<{ readonly serverName: string; readonly url: string }> {
  const urls: Array<{ readonly serverName: string; readonly url: string }> = [];
  for (const [serverName, definition] of Object.entries(filterEnabledMcpServers(servers))) {
    const normalized = normalizeCommonEntry(definition);
    if (normalized.oauthCallbackUrl !== undefined) {
      urls.push({ serverName, url: normalized.oauthCallbackUrl });
    }
  }
  return urls;
}

export function readCodexMcpOAuthCallbackConfig(
  servers: McpProjectServersConfig | null | undefined,
): CodexMcpOAuthCallbackConfig {
  const ports = readCodexMcpOAuthCallbackPorts(servers);
  const uniquePorts = new Set(ports.map(({ port }) => port));
  if (uniquePorts.size > 1) {
    throw new CodexMcpOAuthCallbackPortConflictError(ports);
  }

  const urls = readCodexMcpOAuthCallbackUrls(servers);
  const uniqueUrls = new Set(urls.map(({ url }) => url));
  if (uniqueUrls.size > 1) {
    throw new CodexMcpOAuthCallbackUrlConflictError(urls);
  }

  return {
    ...(ports[0]?.port !== undefined ? { port: ports[0].port } : {}),
    ...(urls[0]?.url !== undefined ? { url: urls[0].url } : {}),
  };
}
