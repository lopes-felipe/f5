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
