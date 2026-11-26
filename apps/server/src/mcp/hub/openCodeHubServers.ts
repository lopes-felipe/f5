import type { McpRemoteConfig } from "@opencode-ai/sdk/v2";

import type { McpHubEndpoint } from "./McpHub.ts";

export interface OpenCodeHubServer {
  readonly name: string;
  readonly config: McpRemoteConfig;
}

/**
 * OpenCode registers hub endpoints through `POST /mcp` as remote servers. OAuth
 * detection stays off: the hub owns sign-in, and the endpoint only takes its
 * bearer credential.
 */
export function hubEndpointsToOpenCodeServers(
  endpoints: ReadonlyArray<McpHubEndpoint>,
): OpenCodeHubServer[] {
  return endpoints.map((endpoint) => ({
    name: endpoint.serverName,
    config: {
      type: "remote",
      url: endpoint.url,
      enabled: true,
      headers: { Authorization: `Bearer ${endpoint.token}` },
      oauth: false,
      timeout: endpoint.toolTimeoutMs,
    },
  }));
}
