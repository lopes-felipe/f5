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

/**
 * Read-only workflow stages: no native shell, patching, web, browser, computer,
 * app, plugin, or delegation tools. Inspection comes from the host MCP server,
 * and these managed args follow user launch args so they win.
 */
const CODEX_READONLY_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "plugins",
  "remote_plugin",
  "code_mode_host",
  "image_generation",
  "multi_agent",
  "skill_mcp_dependency_install",
] as const;

export const CODEX_READONLY_WORKFLOW_CONFIG_ARGS: ReadonlyArray<string> = [
  ...CODEX_READONLY_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
  "-c",
  "include_apply_patch_tool=false",
  "-c",
  'web_search="disabled"',
];

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
  options?: {
    readonly mcpOAuthCallbackPort?: number | null;
    readonly mcpOAuthCallbackUrl?: string | null;
  },
): ReadonlyArray<string> {
  const callbackPort = options?.mcpOAuthCallbackPort;
  const callbackUrl = options?.mcpOAuthCallbackUrl?.trim();
  return [
    "-c",
    `mcp_servers=${encodeTomlInlineValue(servers ?? {})}`,
    ...(typeof callbackPort === "number" &&
    Number.isInteger(callbackPort) &&
    callbackPort > 0 &&
    callbackPort <= 65535
      ? ["-c", `mcp_oauth_callback_port=${callbackPort}`]
      : []),
    ...(callbackUrl ? ["-c", `mcp_oauth_callback_url=${encodeTomlInlineValue(callbackUrl)}`] : []),
  ];
}

export function prependCodexCliTelemetryDisabledConfig(
  args: ReadonlyArray<string>,
  options?: {
    readonly managedCredentials?: boolean;
    readonly mcpServers?: Record<string, CodexMcpServerEntry> | null;
    readonly mcpOAuthCallbackPort?: number | null;
    readonly mcpOAuthCallbackUrl?: string | null;
    readonly readOnlyWorkflow?: boolean;
  },
): ReadonlyArray<string> {
  return [
    ...CODEX_TELEMETRY_DISABLED_CONFIG_ARGS,
    ...(options?.readOnlyWorkflow ? CODEX_READONLY_WORKFLOW_CONFIG_ARGS : []),
    ...(options?.managedCredentials ? ["-c", 'cli_auth_credentials_store="file"'] : []),
    ...buildCodexCliMcpConfigArgs(
      options?.mcpServers,
      options?.mcpOAuthCallbackPort || options?.mcpOAuthCallbackUrl
        ? {
            ...(options.mcpOAuthCallbackPort
              ? { mcpOAuthCallbackPort: options.mcpOAuthCallbackPort }
              : {}),
            ...(options.mcpOAuthCallbackUrl
              ? { mcpOAuthCallbackUrl: options.mcpOAuthCallbackUrl }
              : {}),
          }
        : {},
    ),
    ...args,
  ];
}
