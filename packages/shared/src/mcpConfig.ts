import type { McpProjectServersConfig } from "@t3tools/contracts";

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

function stableMcpServersJson(servers: McpProjectServersConfig): string {
  return JSON.stringify(sortJsonForStableStringify(servers));
}

export function mergeMcpServerLayers(input: {
  readonly common?: McpProjectServersConfig | null;
  readonly project?: McpProjectServersConfig | null;
}): McpProjectServersConfig {
  return {
    ...input.common,
    ...input.project,
  };
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
