import {
  PROVIDER_DISPLAY_NAMES,
  type McpHubServerStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { mcpHubStatusQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

/** Agents that reach project MCP servers through F5's hub instead of their own client. */
export const MCP_HUB_PROVIDER_LABELS = [
  "Cursor",
  "Grok",
  "Antigravity",
  "custom ACP agents",
  "OpenCode",
  "Muse Code",
  "Pi",
] as const;

function HubStateBadge({ server }: { readonly server: McpHubServerStatus }) {
  switch (server.state) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "connecting":
      return <Badge variant="info">Connecting</Badge>;
    case "retrying":
      return <Badge variant="warning">Reconnecting</Badge>;
    case "needs-auth":
      return <Badge variant="warning">Needs sign-in</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    default:
      return <Badge variant="outline">Idle</Badge>;
  }
}

function describeServer(server: McpHubServerStatus): string {
  const parts = [
    server.providers.map((provider) => PROVIDER_DISPLAY_NAMES[provider]).join(", "),
    `${server.attachedSessions} ${server.attachedSessions === 1 ? "session" : "sessions"}`,
    server.connectionScope === "shared" ? "shared connection" : "one connection per session",
  ];
  if (server.toolCount !== undefined)
    parts.push(`${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`);
  return parts.filter(Boolean).join(" · ");
}

/**
 * Stopgap until the settings redesign: shows the hub connections that serve
 * agents without their own MCP client support in F5.
 */
export function McpHubStatusPanel({ projectId }: { readonly projectId: ProjectId }) {
  const queryClient = useQueryClient();
  const hubStatus = useQuery(mcpHubStatusQueryOptions({ projectId }));
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const servers = hubStatus.data?.servers ?? [];

  const reconnect = async (serverName: string) => {
    setReconnecting(serverName);
    setActionError(null);
    try {
      await ensureNativeApi().mcp.reconnectHubServer({ serverName, projectId });
      await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.hubStatus(projectId) });
    } catch (error) {
      setActionError(readErrorMessage(error, `Could not reconnect ${serverName}.`));
    } finally {
      setReconnecting(null);
    }
  };

  return (
    <section
      aria-label="Other agents"
      className="space-y-2 rounded-lg border border-border p-3 text-xs"
    >
      <p className="font-medium text-foreground">Other agents</p>
      <p className="text-muted-foreground">
        {MCP_HUB_PROVIDER_LABELS.join(", ")} get these servers through F5 when a session starts.
        Saved changes reach them in their next session. Servers that need sign-in are not available
        to them yet.
      </p>
      {hubStatus.error ? (
        <p className="text-destructive">
          {readErrorMessage(hubStatus.error, "Failed to load MCP connections for other agents.")}
        </p>
      ) : null}
      {actionError ? <p className="text-destructive">{actionError}</p> : null}
      {servers.length === 0 && !hubStatus.error ? (
        <p className="text-muted-foreground">No agent session is using these servers right now.</p>
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => (
            <li
              key={`${server.name}:${server.connectionScope}`}
              className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5"
            >
              <span className="font-medium text-foreground">{server.name}</span>
              <HubStateBadge server={server} />
              <span className="text-muted-foreground">{describeServer(server)}</span>
              {server.error ? (
                <span className="basis-full text-muted-foreground">{server.error}</span>
              ) : null}
              {server.state === "failed" || server.state === "retrying" ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  disabled={reconnecting !== null}
                  onClick={() => void reconnect(server.name)}
                >
                  {reconnecting === server.name ? "Reconnecting..." : "Reconnect"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
