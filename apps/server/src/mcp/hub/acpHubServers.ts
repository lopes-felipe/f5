import type { McpServer } from "effect-acp/schema";

import {
  MCP_SESSION_TOKEN_ENV,
  MCP_SESSION_URL_ENV,
  type McpSessionStdioLaunch,
} from "../sessionStdioShim.ts";
import type { McpHubEndpoint, McpHubOmission } from "./McpHub.ts";

/**
 * ACP entries for hub endpoints. Hub endpoints are always streamable HTTP, so
 * an agent with HTTP MCP connects directly; otherwise `t3 mcp-session-stdio`
 * relays stdio to the endpoint.
 *
 * The relay makes one request per POST and has no notification stream, so
 * `list_changed` and progress notifications do not reach those agents; their
 * catalog is the one listed at session start (documented in mcp-servers.md).
 */
export function hubEndpointsToAcpServers(
  endpoints: ReadonlyArray<McpHubEndpoint>,
  input: { readonly http: boolean; readonly stdioLaunch?: McpSessionStdioLaunch | undefined },
): { readonly servers: McpServer[]; readonly omitted: McpHubOmission[] } {
  const servers: McpServer[] = [];
  const omitted: McpHubOmission[] = [];
  for (const endpoint of endpoints) {
    if (input.http) {
      servers.push({
        type: "http",
        name: endpoint.serverName,
        url: endpoint.url,
        headers: [{ name: "Authorization", value: `Bearer ${endpoint.token}` }],
      });
    } else if (input.stdioLaunch) {
      servers.push({
        name: endpoint.serverName,
        command: input.stdioLaunch.command,
        args: [...input.stdioLaunch.args],
        env: [
          ...Object.entries(input.stdioLaunch.env).map(([name, value]) => ({ name, value })),
          { name: MCP_SESSION_URL_ENV, value: endpoint.url },
          { name: MCP_SESSION_TOKEN_ENV, value: endpoint.token },
        ],
      });
    } else {
      omitted.push({
        serverName: endpoint.serverName,
        reason: "needs HTTP MCP, which this agent does not offer",
      });
    }
  }
  return { servers, omitted };
}
