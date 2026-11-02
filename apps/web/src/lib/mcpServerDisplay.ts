/**
 * How MCP servers read on tool-call cards: a human label, a built-in icon or tinted
 * monogram, a one-line result preview and a card-level status.
 */

/** F5's own servers, keyed without the leading underscores some providers add. */
const F5_SERVER_LABELS: Readonly<Record<string, string>> = {
  f5_thread: "F5 threads",
  f5_preview: "F5 preview",
  f5_computer: "F5 computer",
};

const CLAUDE_AI_TOOL_PREFIX = "claude_ai_";
const CLAUDE_AI_NAME_PREFIX = /^claude\.ai\s+/i;

function bareServerName(serverName: string): string {
  return serverName.replace(/^_+/, "");
}

/** Claude Code's flattening of a server name inside `mcp__<server>__<tool>`. */
export function mcpToolNameServerKey(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The server's display label. Tool names only carry a flattened server name
 * ("claude_ai_Claude_Docs"), so real names from status events win when one flattens to it.
 */
export function resolveMcpServerLabel(
  serverName: string,
  statusNamesByKey: ReadonlyMap<string, string>,
): string {
  const bare = bareServerName(serverName);
  const builtIn = F5_SERVER_LABELS[bare.toLowerCase()];
  if (builtIn) return builtIn;
  const realName = statusNamesByKey.get(serverName) ?? statusNamesByKey.get(bare);
  if (realName) return realName.replace(CLAUDE_AI_NAME_PREFIX, "").trim() || realName;
  const withoutConnectorPrefix = bare.startsWith(CLAUDE_AI_TOOL_PREFIX)
    ? bare.slice(CLAUDE_AI_TOOL_PREFIX.length)
    : bare;
  const words = withoutConnectorPrefix.split("_").filter((word) => word.length > 0);
  if (words.length === 0) return serverName;
  const label = words.join(" ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

export type McpServerIconKind =
  | "github"
  | "linear"
  | "slack"
  | "notion"
  | "figma"
  | "claude"
  | "f5"
  | "monogram";

const BRAND_ICON_KINDS = ["github", "linear", "slack", "notion", "figma"] as const;

export function mcpServerIconKind(serverName: string, label: string): McpServerIconKind {
  const haystack = `${serverName} ${label}`.toLowerCase();
  const brand = BRAND_ICON_KINDS.find((kind) => haystack.includes(kind));
  if (brand) return brand;
  const bare = bareServerName(serverName).toLowerCase();
  if (bare.startsWith(CLAUDE_AI_TOOL_PREFIX)) return "claude";
  if (bare.startsWith("f5_")) return "f5";
  return "monogram";
}

export const MCP_SERVER_TINT_COUNT = 6;

/** A stable chart palette index (1–6) for a server, so monograms tell servers apart. */
export function mcpServerTint(serverName: string): number {
  let hash = 0;
  for (let index = 0; index < serverName.length; index++) {
    hash = (hash * 31 + serverName.charCodeAt(index)) | 0;
  }
  return (Math.abs(hash) % MCP_SERVER_TINT_COUNT) + 1;
}

const RESULT_PREVIEW_MAX_CHARS = 160;

/**
 * One line of a call's result: JSON objects as `key: value` pairs, anything else as its
 * first non-empty line. `summarizePairs` turns a parsed object into pairs.
 */
export function summarizeMcpResult(
  result: string | undefined,
  parseObject: (text: string) => Record<string, unknown> | null,
  summarizePairs: (input: Record<string, unknown>) => string | null,
): string | null {
  const trimmed = result?.trim();
  if (!trimmed) return null;
  const parsed = parseObject(trimmed);
  const pairs = parsed ? summarizePairs(parsed) : null;
  const line =
    pairs ??
    trimmed
      .split("\n")
      .map((candidate) => candidate.replace(/\s+/g, " ").trim())
      .find((candidate) => candidate.length > 0) ??
    null;
  if (!line) return null;
  return line.length > RESULT_PREVIEW_MAX_CHARS
    ? `${line.slice(0, RESULT_PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : line;
}

export type McpCallDisplayStatus = "running" | "failed" | "declined" | "completed";

/** A card's accent: running wins, then any failure, then all-declined, else completed. */
export function mcpAggregateStatus(
  statuses: ReadonlyArray<McpCallDisplayStatus>,
): McpCallDisplayStatus {
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.length > 0 && statuses.every((status) => status === "declined")) {
    return "declined";
  }
  return "completed";
}
