import { normalizeServerName } from "./mcpServerName";
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
    ...(entry.args !== undefined ? { args: [...entry.args] } : {}),
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
      const normalizedName = normalizeServerName(name) ?? name.trim();
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

export const CODEX_SSE_TRANSPORT_HINT =
  "Codex connects to this URL with streamable HTTP. SSE-only endpoints fail under Codex; switch the type to HTTP if the server supports it.";

export interface McpToolFilter {
  readonly enabled: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
}

export type McpToolFilters = ReadonlyMap<string, McpToolFilter>;

export function normalizeClaudeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function buildMcpToolFilters(
  servers: McpProjectServersConfig | null | undefined,
): McpToolFilters {
  return new Map(
    Object.entries(filterEnabledMcpServers(servers)).map(([name, server]) => [
      name,
      {
        enabled: new Set(normalizeOptionalStringArray(server.enabledTools) ?? []),
        disabled: new Set(normalizeOptionalStringArray(server.disabledTools) ?? []),
      },
    ]),
  );
}

export function claudeDisallowedMcpToolNames(filters: McpToolFilters): string[] {
  return [
    ...new Set(
      [...filters].flatMap(([name, filter]) =>
        [...filter.disabled].map((tool) => `mcp__${normalizeClaudeMcpName(name)}__${tool}`),
      ),
    ),
  ];
}

/** Returns a denial reason; undefined leaves native permission evaluation intact. */
export function evaluateMcpToolFilter(
  filters: McpToolFilters,
  ownedNames: ReadonlySet<string>,
  toolName: string,
  mcpServer?: { readonly name: string; readonly source?: string },
): string | undefined {
  if (mcpServer?.source !== undefined && mcpServer.source !== "dynamic") return;
  // Older hook messages omit provenance. Match exact prefixes, preserving '__'
  // inside both the server and tool names. Check every match to fail closed on
  // aliases that normalize to the same Claude name.
  const names = mcpServer
    ? [mcpServer.name]
    : [...ownedNames].filter((name) =>
        toolName.startsWith(`mcp__${normalizeClaudeMcpName(name)}__`),
      );
  for (const name of names) {
    const filter = filters.get(name);
    if (!ownedNames.has(name)) continue;
    const prefix = `mcp__${normalizeClaudeMcpName(name)}__`;
    const tool = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : undefined;
    // A removed or disabled launch-time server can stay connected until restart.
    // Ownership outlives its filter, so absence must deny rather than allow.
    if (!filter) {
      return `Tool '${tool ?? toolName}' from MCP server '${name}' is blocked because the server was removed or disabled in F5 MCP settings. Apply the saved settings to restart this session.`;
    }
    if (
      tool === undefined ||
      filter.disabled.has(tool) ||
      (filter.enabled.size > 0 && !filter.enabled.has(tool))
    ) {
      return `Tool '${tool ?? toolName}' from MCP server '${name}' is blocked by F5 MCP settings. Review this server's enabled and disabled tools in F5 MCP settings.`;
    }
  }
}

export function translateMcpForClaudeAgent(
  servers: McpProjectServersConfig | null | undefined,
): Record<string, ClaudeAgentMcpServerConfig> | undefined {
  const translated = Object.create(null) as Record<string, ClaudeAgentMcpServerConfig>;
  for (const [name, definition] of Object.entries(filterEnabledMcpServers(servers))) {
    const normalized = normalizeCommonEntry(definition);
    // Claude ignores sub-second values, including the saved zero/default value.
    const timeout =
      normalized.toolTimeoutSec && normalized.toolTimeoutSec > 0
        ? { timeout: normalized.toolTimeoutSec * 1000 }
        : {};
    if (definition.type === "stdio") {
      if (!normalized.command) {
        continue;
      }
      translated[name] = {
        type: "stdio",
        ...timeout,
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
      ...timeout,
      url: normalized.url,
      ...(normalized.headers ? { headers: normalized.headers } : {}),
      ...(normalized.oauthClientId || normalized.oauthCallbackPort !== undefined
        ? {
            oauth: {
              ...(normalized.oauthClientId ? { clientId: normalized.oauthClientId } : {}),
              ...(normalized.oauthCallbackPort !== undefined
                ? { callbackPort: normalized.oauthCallbackPort }
                : {}),
            },
          }
        : {}),
    };
  }

  return Object.keys(translated).length > 0 ? { ...translated } : undefined;
}

export function translateMcpForCodex(
  servers: McpProjectServersConfig | null | undefined,
): Record<string, CodexMcpServerEntry> | undefined {
  const translated = Object.create(null) as Record<string, CodexMcpServerEntry>;
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
      ...(normalized.enabledTools?.length ? { enabled_tools: normalized.enabledTools } : {}),
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
      ...(normalized.headers ? { http_headers: normalized.headers } : {}),
      ...shared,
    };
  }

  return Object.keys(translated).length > 0 ? { ...translated } : undefined;
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
