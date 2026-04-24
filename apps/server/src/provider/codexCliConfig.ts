import type { CodexMcpServerEntry } from "@t3tools/contracts";

const CODEX_TELEMETRY_DISABLED_CONFIG_ARGS = [
  "-c",
  "analytics.enabled=false",
  "-c",
  'otel.exporter="none"',
  "-c",
  'otel.metrics_exporter="none"',
  "-c",
  'otel.trace_exporter="none"',
] as const satisfies ReadonlyArray<string>;

function encodeTomlInlineValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => encodeTomlInlineValue(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}=${encodeTomlInlineValue(entry)}`)
      .join(",")}}`;
  }
  return "{}";
}

export function buildCodexCliMcpConfigArgs(
  servers: Record<string, CodexMcpServerEntry> | null | undefined,
): ReadonlyArray<string> {
  return ["-c", `mcp_servers=${encodeTomlInlineValue(servers ?? {})}`];
}

export function prependCodexCliTelemetryDisabledConfig(
  args: ReadonlyArray<string>,
  options?: {
    readonly mcpServers?: Record<string, CodexMcpServerEntry> | null;
  },
): ReadonlyArray<string> {
  return [
    ...CODEX_TELEMETRY_DISABLED_CONFIG_ARGS,
    ...buildCodexCliMcpConfigArgs(options?.mcpServers),
    ...args,
  ];
}
