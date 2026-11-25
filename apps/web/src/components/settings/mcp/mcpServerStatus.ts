import type {
  McpHubServerStatus,
  McpServerDefinition,
  McpServerStatusEntry,
} from "@t3tools/contracts";

export type McpStatusTone = "success" | "info" | "warning" | "error" | "outline";

/** One place a server's state was seen: F5's hub, or a Codex or Claude account. */
export interface McpStatusSource {
  readonly label: string;
  readonly state: "ready" | "connecting" | "needs-auth" | "failed" | "idle";
  readonly detail?: string | undefined;
  readonly toolCount?: number | undefined;
}

export interface McpServerStatusSummary {
  readonly tone: McpStatusTone;
  readonly label: string;
  /** The failure reason or tool count shown under the name. */
  readonly detail?: string | undefined;
  /** Which source the label comes from, when there is more than one. */
  readonly source?: string | undefined;
}

export function hubStatusSources(
  entries: ReadonlyArray<McpHubServerStatus>,
): ReadonlyArray<McpStatusSource> {
  return entries.map((entry) => ({
    label: "Other agents",
    state:
      entry.state === "ready"
        ? "ready"
        : entry.state === "connecting" || entry.state === "retrying"
          ? "connecting"
          : entry.state === "needs-auth"
            ? "needs-auth"
            : entry.state === "failed"
              ? "failed"
              : "idle",
    detail: entry.error,
    toolCount: entry.toolCount,
  }));
}

export function observedStatusSource(
  label: string,
  entry: McpServerStatusEntry | undefined,
): McpStatusSource | undefined {
  if (!entry) return undefined;
  const state =
    entry.state === "ready"
      ? "ready"
      : entry.state === "starting"
        ? "connecting"
        : entry.state === "needs-auth" || entry.state === "login-required"
          ? "needs-auth"
          : entry.state === "failed"
            ? "failed"
            : "idle";
  return {
    label,
    state,
    detail: entry.message,
    toolCount: state === "ready" || entry.toolCount > 0 ? entry.toolCount : undefined,
  };
}

const PRIORITY: ReadonlyArray<McpStatusSource["state"]> = [
  "failed",
  "needs-auth",
  "connecting",
  "ready",
];

function toolLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

/**
 * The row status: the most urgent state any source reports, so a failure in one
 * provider is never hidden by another provider's ready connection.
 */
export function summarizeMcpServerStatus(
  server: McpServerDefinition,
  sources: ReadonlyArray<McpStatusSource | undefined>,
): McpServerStatusSummary {
  if (server.enabled === false) return { tone: "outline", label: "Disabled" };
  const known = sources.filter((source): source is McpStatusSource => source !== undefined);
  const multiple = new Set(known.map((source) => source.label)).size > 1;
  for (const state of PRIORITY) {
    const match = known.find((source) => source.state === state);
    if (!match) continue;
    const source = multiple ? match.label : undefined;
    if (state === "failed") return { tone: "error", label: "Failed", detail: match.detail, source };
    if (state === "needs-auth")
      return { tone: "warning", label: "Needs sign-in", detail: match.detail, source };
    if (state === "connecting") return { tone: "info", label: "Connecting", source };
    const tools = Math.max(
      ...known.filter((entry) => entry.state === "ready").map((entry) => entry.toolCount ?? 0),
    );
    return {
      tone: "success",
      label: "Ready",
      detail: known.some((entry) => entry.toolCount !== undefined) ? toolLabel(tools) : undefined,
      source,
    };
  }
  return { tone: "outline", label: "Not connected" };
}
