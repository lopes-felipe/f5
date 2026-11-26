import type { McpProjectServersConfig } from "@t3tools/contracts";
import { mcpServerNameKey } from "./mcpServerName";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortJsonForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonForStableStringify(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entry]) => [key, sortJsonForStableStringify(entry)]),
  );
}

export function stableMcpServersJson(servers: McpProjectServersConfig): string {
  return JSON.stringify(sortJsonForStableStringify(servers));
}

/**
 * Common, then approved repository (`.mcp.json`) servers, then project servers; a
 * later layer wins a name. The project's opt-outs turn off common and repository
 * servers alike.
 */
export function mergeMcpServerLayers(input: {
  readonly common?: McpProjectServersConfig | null;
  readonly repository?: McpProjectServersConfig | null;
  readonly project?: McpProjectServersConfig | null;
  readonly disabledCommon?: ReadonlyArray<string> | undefined;
}): McpProjectServersConfig {
  const disabled = new Set(input.disabledCommon?.map(mcpServerNameKey));
  const optedOut = (servers: McpProjectServersConfig | null | undefined) =>
    Object.fromEntries(
      Object.entries(servers ?? {}).map(([name, server]) => [
        name,
        disabled.has(mcpServerNameKey(name)) ? { ...server, enabled: false } : server,
      ]),
    );
  // Repository names compare case-insensitively against both neighbours, so a
  // differently spelled name never runs twice.
  const keysOf = (servers: McpProjectServersConfig | null | undefined) =>
    new Set(Object.keys(servers ?? {}).map(mcpServerNameKey));
  const without = (servers: McpProjectServersConfig | null | undefined, keys: Set<string>) =>
    Object.fromEntries(
      Object.entries(servers ?? {}).filter(([name]) => !keys.has(mcpServerNameKey(name))),
    );
  const repository = without(input.repository, keysOf(input.project));
  const common = input.repository ? without(input.common, keysOf(repository)) : input.common;
  return { ...optedOut(common), ...optedOut(repository), ...input.project };
}

export function computeEffectiveMcpConfigVersion(servers: McpProjectServersConfig): string {
  const bytes = new TextEncoder().encode(stableMcpServersJson(servers));
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return `mcp-${hash.toString(16).padStart(16, "0")}`;
}

export function formatMcpServersAsJson(servers: McpProjectServersConfig): string {
  return `${JSON.stringify(
    {
      mcpServers: sortJsonForStableStringify(servers),
    },
    null,
    2,
  )}\n`;
}
