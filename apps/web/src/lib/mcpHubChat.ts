import type {
  CompactMcpStatusActivityPayload,
  CompactMcpStatusActivityStatus,
  McpHubServerState,
  McpHubServerStatus,
  ProjectId,
  ProviderKind,
} from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { MCP_HUB_PROVIDERS } from "@t3tools/shared/mcpProviderSupport";
import { useQuery } from "@tanstack/react-query";

import { useSettings } from "../hooks/useSettings";
import { mcpHubStatusQueryOptions } from "./mcpReactQuery";
import { useMcpStatusUpdates } from "./useMcpStatusUpdates";

const CHIP_STATUS: Record<McpHubServerState, CompactMcpStatusActivityStatus> = {
  idle: "starting",
  connecting: "starting",
  retrying: "starting",
  ready: "ready",
  "needs-auth": "needs-auth",
  failed: "failed",
  stopped: "cancelled",
};

// Worst first, so a server with several connections shows its most urgent state.
const SEVERITY: ReadonlyArray<CompactMcpStatusActivityStatus> = [
  "failed",
  "needs-auth",
  "starting",
  "cancelled",
  "ready",
];

/**
 * The hub connections serving `provider` in `projectId`, one entry per server, shaped
 * like the chat's MCP status activities. A server with a connection per session
 * reports its worst state.
 */
export function hubServersForChat(
  servers: ReadonlyArray<McpHubServerStatus>,
  provider: ProviderKind,
  projectId: ProjectId,
): CompactMcpStatusActivityPayload[] {
  const byName = new Map<string, CompactMcpStatusActivityPayload>();
  for (const entry of servers) {
    if (!entry.providers.includes(provider) || !entry.projectIds.includes(projectId)) continue;
    const next: CompactMcpStatusActivityPayload = {
      name: entry.name,
      status: CHIP_STATUS[entry.state],
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.toolCount !== undefined ? { toolCount: entry.toolCount } : {}),
    };
    const key = mcpServerNameKey(entry.name);
    const current = byName.get(key);
    if (!current || SEVERITY.indexOf(next.status) < SEVERITY.indexOf(current.status))
      byName.set(key, next);
  }
  return [...byName.values()].toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

export function isMcpHubProvider(
  provider: ProviderKind | null,
  nativeProvidersOnHub = false,
): provider is ProviderKind {
  return (
    provider !== null &&
    (MCP_HUB_PROVIDERS.includes(provider) ||
      (nativeProvidersOnHub && (provider === "codex" || provider === "claudeAgent")))
  );
}

/** Whether Codex and Claude reach configured servers through F5's hub too. */
export function useNativeProvidersOnHub(): boolean {
  return useSettings((settings) => !settings.mcpNativePassthrough);
}

/**
 * Hub status for a conversation whose agent reaches MCP servers through F5. Pushed,
 * never polled; `null` when the agent reaches no server through the hub (Codex and
 * Claude with `mcpNativePassthrough`, which report their own status).
 */
export function useMcpHubChatServers(
  provider: ProviderKind | null,
  projectId: ProjectId | null,
): CompactMcpStatusActivityPayload[] | null {
  const hubProvider = isMcpHubProvider(provider, useNativeProvidersOnHub()) && projectId !== null;
  useMcpStatusUpdates(hubProvider);
  const query = useQuery(mcpHubStatusQueryOptions({ projectId, enabled: hubProvider }));
  // A reply without a server list (an older server) means no hub status to show.
  if (!hubProvider || !Array.isArray(query.data?.servers)) return null;
  return hubServersForChat(query.data.servers, provider, projectId);
}

/**
 * The chat chip's servers: hub entries for servers F5 serves, then the agent's own
 * reports for the rest (Codex's and Claude's provider-managed servers). A name both
 * report shows the hub entry, since the agent only sees F5's endpoint for it.
 */
export function mergeChatMcpServers(
  hubServers: ReadonlyArray<CompactMcpStatusActivityPayload> | null,
  activityServers: ReadonlyArray<CompactMcpStatusActivityPayload>,
): { servers: CompactMcpStatusActivityPayload[]; hubNames: ReadonlySet<string> } {
  const hubNames = new Set(
    (hubServers ?? []).flatMap((server) => (server.name ? [mcpServerNameKey(server.name)] : [])),
  );
  return {
    servers: [
      ...(hubServers ?? []),
      ...activityServers.filter(
        (server) => !server.name || !hubNames.has(mcpServerNameKey(server.name)),
      ),
    ],
    hubNames,
  };
}
