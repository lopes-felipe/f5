import {
  McpServerWriteDefinition,
  type McpConfigIssue,
  type McpProjectServersConfig,
  type ProviderKind,
} from "@t3tools/contracts";
import { Schema, SchemaIssue } from "effect";
import { mergeMcpServerLayers, stableMcpServersJson } from "./mcpConfig";
import { mcpServerNameKey, normalizeServerName } from "./mcpServerName";

export {
  MAX_SERVER_NAME_LENGTH,
  mcpServerNameKey,
  normalizeServerName,
  trimToUndefined,
} from "./mcpServerName";

export const MCP_SERVERS_PER_SCOPE = 16;
export const MCP_EFFECTIVE_SERVER_LIMIT = 32;
export const MCP_INTERNAL_SERVER_RESERVE = 4;
export const MCP_RUNTIME_SERVER_LIMIT = MCP_EFFECTIVE_SERVER_LIMIT + MCP_INTERNAL_SERVER_RESERVE;
export const MAX_SERVER_COUNT = MCP_SERVERS_PER_SCOPE;

// Normalization must never discard legacy entries or rewrite their values.
export function normalizeMcpServersRecord(
  value: McpProjectServersConfig | null | undefined,
): McpProjectServersConfig {
  return { ...value };
}

export function mcpConfigErrorMessage(cause: unknown): string {
  if (
    Schema.isSchemaError(cause) ||
    (cause instanceof Error &&
      (SchemaIssue.isIssue(cause.cause) || Schema.isSchemaError(cause.cause)))
  )
    return "Invalid MCP server fields. Check the command, HTTP/HTTPS URLs, and advanced options in F5 MCP settings.";
  return cause instanceof Error ? cause.message : String(cause);
}

function equalEntry(left: McpProjectServersConfig[string], right: McpProjectServersConfig[string]) {
  return stableMcpServersJson({ entry: left }) === stableMcpServersJson({ entry: right });
}

function collisionGroups(servers: McpProjectServersConfig): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(servers)) {
    const key = mcpServerNameKey(name);
    const names = groups.get(key);
    if (names) names.push(name);
    else groups.set(key, [name]);
  }
  return groups;
}

export function readMcpValidationIssues(servers: McpProjectServersConfig): McpConfigIssue[] {
  const issues: McpConfigIssue[] = [];
  if (Object.keys(servers).length > MCP_SERVERS_PER_SCOPE) {
    issues.push({
      kind: "validation",
      message: `This layer exceeds the ${MCP_SERVERS_PER_SCOPE}-server scope limit. Remove entries before adding new names.`,
    });
  }
  for (const [serverName, server] of Object.entries(servers)) {
    if (!normalizeServerName(serverName)) {
      issues.push({
        kind: "validation",
        serverName,
        message: "Server names must contain 1–128 characters.",
      });
    }
    try {
      Schema.decodeUnknownSync(McpServerWriteDefinition)(server);
    } catch (error) {
      issues.push({
        kind: "validation",
        serverName,
        message: `Invalid MCP server '${serverName}': ${mcpConfigErrorMessage(error)}`,
      });
    }
  }
  for (const names of collisionGroups(servers).values()) {
    if (names.length > 1)
      issues.push({
        kind: "validation",
        message: `Conflicting MCP server names: ${names.join(", ")}. Names are case-insensitive.`,
      });
  }
  return issues;
}

/** Strictly validate changed entries, while allowing independent legacy repairs. */
export function validateMcpLayerWrite(
  base: McpProjectServersConfig,
  submitted: McpProjectServersConfig,
): McpProjectServersConfig {
  const next = Object.create(null) as Record<string, McpProjectServersConfig[string]>;
  const addedNames = Object.keys(submitted).filter((name) => !Object.hasOwn(base, name));
  if (
    (Object.keys(base).length > MCP_SERVERS_PER_SCOPE && addedNames.length > 0) ||
    (Object.keys(base).length <= MCP_SERVERS_PER_SCOPE &&
      Object.keys(submitted).length > MCP_SERVERS_PER_SCOPE)
  ) {
    throw new Error(
      `You can save at most ${MCP_SERVERS_PER_SCOPE} MCP servers per scope. An oversized legacy layer cannot add new names.`,
    );
  }
  for (const [name, server] of Object.entries(submitted)) {
    const unchanged = Object.hasOwn(base, name) && equalEntry(base[name]!, server);
    const storedName = unchanged ? name : normalizeServerName(name);
    if (!storedName)
      throw new Error("Server name is required and must be 128 characters or fewer.");
    if (Object.hasOwn(next, storedName))
      throw new Error(`Conflicting MCP server name '${storedName}'.`);
    next[storedName] = unchanged
      ? server
      : Schema.decodeUnknownSync(McpServerWriteDefinition)(server);
  }
  const previousGroups = collisionGroups(base);
  for (const [key, names] of collisionGroups(next)) {
    if (names.length < 2) continue;
    const previous = previousGroups.get(key) ?? [];
    const subset = names.every((name) => previous.includes(name));
    const unchanged = names.every(
      (name) => Object.hasOwn(base, name) && equalEntry(base[name]!, next[name]!),
    );
    if (!subset || (names.length >= previous.length && !unchanged)) {
      throw new Error(
        `Conflicting MCP server names: ${names.join(", ")}. Names are case-insensitive.`,
      );
    }
  }
  return { ...next };
}

export function readMcpLayerNameConflicts(
  common: McpProjectServersConfig,
  project: McpProjectServersConfig,
): McpConfigIssue[] {
  const issues: McpConfigIssue[] = [];
  for (const name of Object.keys(project)) {
    const aliases = Object.keys(common).filter(
      (other) => other !== name && mcpServerNameKey(other) === mcpServerNameKey(name),
    );
    if (aliases.length > 0)
      issues.push({
        kind: "validation",
        serverName: name,
        message: `Project server '${name}' conflicts with common server '${aliases.join(", ")}'. Use an exact name for an override.`,
      });
  }
  return issues;
}

export function validateMcpLayerMerge(input: {
  common: McpProjectServersConfig;
  project: McpProjectServersConfig;
  baseCommon: McpProjectServersConfig;
  baseProject: McpProjectServersConfig;
}): void {
  const effective = mergeMcpServerLayers(input);
  const previous = mergeMcpServerLayers({ common: input.baseCommon, project: input.baseProject });
  const counts = (servers: McpProjectServersConfig) => [
    Object.keys(servers).length,
    Object.values(servers).filter((server) => server.enabled !== false).length,
  ];
  const previousCounts = counts(previous);
  if (
    counts(effective).some(
      (count, index) => count > MCP_EFFECTIVE_SERVER_LIMIT && count > previousCounts[index]!,
    )
  ) {
    throw new Error(
      `This change would exceed the ${MCP_EFFECTIVE_SERVER_LIMIT}-server effective limit. Remove entries or add exact-name overrides in F5 MCP settings.`,
    );
  }
  const participants = (
    common: McpProjectServersConfig,
    project: McpProjectServersConfig,
    key: string,
  ) =>
    new Map(
      (
        [
          ["common", common],
          ["project", project],
        ] as const
      ).flatMap(([scope, servers]) =>
        Object.entries(servers)
          .filter(([name]) => mcpServerNameKey(name) === key)
          .map(([name, server]) => [`${scope}\0${name}`, server] as const),
      ),
    );
  for (const issue of readMcpLayerNameConflicts(input.common, input.project)) {
    const key = mcpServerNameKey(issue.serverName!);
    const next = participants(input.common, input.project, key);
    const previous = participants(input.baseCommon, input.baseProject, key);
    const subset = [...next.keys()].every((name) => previous.has(name));
    const unchanged = [...next].every(
      ([name, server]) => previous.has(name) && equalEntry(server, previous.get(name)!),
    );
    if (!subset || (next.size >= previous.size && !unchanged)) throw new Error(issue.message);
  }
}

export function assertMcpServerLimit(
  servers: Readonly<Record<string, unknown>> | null | undefined,
  limit = MCP_EFFECTIVE_SERVER_LIMIT,
): void {
  if (Object.keys(servers ?? {}).length > limit)
    throw new Error(`MCP configuration exceeds the ${limit}-server limit.`);
}

/** A provider argument validates stored runtime config; omitted means strict client input. */
export function assertMcpRuntimeConfig(
  servers: McpProjectServersConfig | null | undefined,
  provider?: ProviderKind,
): void {
  const checked = provider
    ? Object.fromEntries(
        Object.entries(servers ?? {}).filter(([, server]) => server.enabled !== false),
      )
    : servers;
  assertMcpServerLimit(checked);
  // Claude can continue using legacy names; new persisted names are checked on writes.
  if (provider === "claudeAgent") return;
  for (const name of Object.keys(checked ?? {})) {
    if (!normalizeServerName(name))
      throw new Error(
        "MCP server names must contain 1–128 characters. Repair the names in F5 MCP settings.",
      );
  }
  for (const names of collisionGroups(checked ?? {}).values()) {
    if (names.length > 1)
      throw new Error(
        `Conflicting MCP server names: ${names.join(", ")}. Repair the names in F5 MCP settings.`,
      );
  }
}
