import type { McpProjectServersConfig, McpServerDefinition } from "@t3tools/contracts";
import { normalizeClaudeMcpName } from "@t3tools/shared/mcpTranslation";

import type { McpHubAttachment, McpHubEndpoint } from "./McpHub.ts";

/**
 * True when Claude's `mcp__<server>__<tool>` names a hub tool F5 will ask about
 * itself, so Claude's own permission prompt for it can be allowed without showing.
 */
export function hubAsksForClaudeTool(
  attachment: Pick<McpHubAttachment, "endpoints" | "asksBeforeCall"> | undefined,
  toolName: string,
  mcpServer?: { readonly name: string },
): boolean {
  if (!attachment?.asksBeforeCall) return false;
  for (const endpoint of attachment.endpoints) {
    if (mcpServer && mcpServer.name !== endpoint.serverName) continue;
    const prefix = `mcp__${normalizeClaudeMcpName(endpoint.serverName)}__`;
    if (!toolName.startsWith(prefix)) continue;
    if (attachment.asksBeforeCall(endpoint.serverName, toolName.slice(prefix.length))) return true;
  }
  return false;
}

/** The tool named in a Codex MCP tool-call consent prompt (`… to run tool "name"?`). */
export function codexMcpConsentToolName(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as { _meta?: unknown; message?: unknown };
  const meta =
    record._meta && typeof record._meta === "object"
      ? (record._meta as Record<string, unknown>)
      : undefined;
  if (meta?.codex_approval_kind !== "mcp_tool_call") return undefined;
  if (typeof meta.tool_name === "string" && meta.tool_name) return meta.tool_name;
  const match =
    typeof record.message === "string" ? /run tool "([^"]+)"\?\s*$/u.exec(record.message) : null;
  return match?.[1];
}

/** Codex and Claude wait this long for a hub endpoint; the hub answers initialize itself. */
const HUB_ENDPOINT_STARTUP_TIMEOUT_SEC = 30;

function hubDefinition(
  endpoint: McpHubEndpoint,
  original: McpServerDefinition | undefined,
): McpServerDefinition & { type: "http" } {
  return {
    type: "http",
    url: endpoint.url,
    enabled: true,
    startupTimeoutSec: HUB_ENDPOINT_STARTUP_TIMEOUT_SEC,
    // The hub enforces the server's own timeout; the provider's must not be shorter.
    toolTimeoutSec: Math.ceil(endpoint.toolTimeoutMs / 1000) + 5,
    ...(original?.supportsParallelToolCalls !== undefined
      ? { supportsParallelToolCalls: original.supportsParallelToolCalls }
      : {}),
    ...(original?.description ? { description: original.description } : {}),
  };
}

/** The environment variable a Codex hub entry reads its credential from. */
export function codexHubTokenEnvVar(index: number): string {
  return `F5_MCP_HUB_TOKEN_${index}`;
}

/**
 * Codex entries for hub endpoints. Credentials travel in environment variables
 * (`bearer_token_env_var`), so Codex's command line holds only loopback URLs.
 * Tool filters are left to the hub, which already applies them.
 */
export function hubEndpointsForCodex(
  endpoints: ReadonlyArray<McpHubEndpoint>,
  original: McpProjectServersConfig | null | undefined,
): { readonly servers: McpProjectServersConfig; readonly env: Record<string, string> } {
  const servers: Record<string, McpServerDefinition> = {};
  const env: Record<string, string> = {};
  endpoints.forEach((endpoint, index) => {
    const envVar = codexHubTokenEnvVar(index);
    servers[endpoint.serverName] = {
      ...hubDefinition(endpoint, original?.[endpoint.serverName]),
      bearerTokenEnvVar: envVar,
    };
    env[envVar] = endpoint.token;
  });
  return { servers, env };
}

/**
 * Claude entries for hub endpoints, with the per-session credential as a header.
 * Header-bearing servers never reach Claude's command line: the SDK delivers them
 * over `initialize`, or F5 sends them over the control channel for older CLIs (see
 * `createClaudeQueryWithPrivateMcp`). The credential only reaches this session's
 * loopback endpoint and is revoked when the session ends.
 */
export function hubEndpointsForClaude(
  endpoints: ReadonlyArray<McpHubEndpoint>,
  original: McpProjectServersConfig | null | undefined,
): McpProjectServersConfig {
  const servers: Record<string, McpServerDefinition> = {};
  for (const endpoint of endpoints)
    servers[endpoint.serverName] = {
      ...hubDefinition(endpoint, original?.[endpoint.serverName]),
      headers: { Authorization: `Bearer ${endpoint.token}` },
    };
  return servers;
}
