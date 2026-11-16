import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import type { CodexControlMcpServerStatus } from "../codex/CodexControlClient.ts";
import { codexObservedMcpStatus } from "./mcpReconcile.ts";
import { classifyMcpOwnership, type ObservedMcpServer } from "./mcpObservation.ts";

/** Only explicit metadata is projected; raw configs and errors never enter inspection. */
export function observeCodexMcpServers(
  statuses: ReadonlyArray<CodexControlMcpServerStatus>,
  owned: ReadonlySet<string>,
  builtIns: ReadonlySet<string> = new Set(),
): ReadonlyArray<ObservedMcpServer> {
  return statuses.map((server) => {
    const raw = server as CodexControlMcpServerStatus & { source?: string; scope?: string };
    const tools = Object.entries(server.tools ?? {}).map(([name, value]) => {
      const tool = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        name: typeof tool.name === "string" ? tool.name : name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      };
    });
    return {
      name: server.name,
      status: codexObservedMcpStatus({
        ...(server.startupStatus ? { startupStatus: server.startupStatus } : {}),
        ...(server.authStatus ? { authStatus: server.authStatus } : {}),
        ...(server.error ? { error: server.error } : {}),
        hasTools:
          tools.length > 0 ||
          (server.resources?.length ?? 0) > 0 ||
          (server.resourceTemplates?.length ?? 0) > 0,
      }),
      ownership: classifyMcpOwnership(
        raw,
        new Set([
          ...owned,
          ...([...owned].filter((name) => mcpServerNameKey(name) === mcpServerNameKey(server.name))
            .length === 1
            ? [server.name]
            : []),
        ]),
        builtIns,
      ),
      authStatus:
        server.authStatus === "notLoggedIn"
          ? "unauthenticated"
          : server.authStatus === "oAuth" || server.authStatus === "bearerToken"
            ? "authenticated"
            : "unknown",
      ...((raw.source ?? raw.scope) ? { origin: raw.source ?? raw.scope! } : {}),
      ...(server.error ? { error: server.error } : {}),
      toolCount: tools.length,
      tools,
      resources: server.resources ?? [],
      resourceTemplates: server.resourceTemplates ?? [],
    };
  });
}
