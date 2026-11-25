import type { McpProjectServersConfig, McpServerDefinition } from "@t3tools/contracts";

import type { McpHubEndpoint } from "./McpHub.ts";

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
  const servers: McpProjectServersConfig = {};
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
 * The SDK passes these on Claude's command line; the credential only reaches this
 * session's loopback endpoint and is revoked when the session ends.
 */
export function hubEndpointsForClaude(
  endpoints: ReadonlyArray<McpHubEndpoint>,
  original: McpProjectServersConfig | null | undefined,
): McpProjectServersConfig {
  const servers: McpProjectServersConfig = {};
  for (const endpoint of endpoints)
    servers[endpoint.serverName] = {
      ...hubDefinition(endpoint, original?.[endpoint.serverName]),
      headers: { Authorization: `Bearer ${endpoint.token}` },
    };
  return servers;
}
