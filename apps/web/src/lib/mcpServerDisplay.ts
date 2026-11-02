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

function capitalizeFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function withoutConnectorPrefix(bare: string): string {
  return bare.startsWith(CLAUDE_AI_TOOL_PREFIX) ? bare.slice(CLAUDE_AI_TOOL_PREFIX.length) : bare;
}

/**
 * The server's display label. Tool names only carry a flattened server name
 * ("claude_ai_Claude_Docs"), so real names from status events win when one flattens to it.
 * Both paths capitalize the same way, so a label stays put when the status event that named
 * the server scrolls out of the activity window.
 */
export function resolveMcpServerLabel(
  serverName: string,
  statusNamesByKey: ReadonlyMap<string, string>,
): string {
  const bare = bareServerName(serverName);
  const builtIn = F5_SERVER_LABELS[bare.toLowerCase()];
  if (builtIn) return builtIn;
  const realName =
    statusNamesByKey.get(mcpToolNameServerKey(serverName)) ??
    statusNamesByKey.get(mcpToolNameServerKey(bare));
  if (realName) {
    return capitalizeFirst(realName.replace(CLAUDE_AI_NAME_PREFIX, "").trim() || realName);
  }
  const words = withoutConnectorPrefix(bare)
    .split("_")
    .filter((word) => word.length > 0);
  if (words.length === 0) return serverName;
  return capitalizeFirst(words.join(" "));
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
  const bare = bareServerName(serverName).toLowerCase();
  // Whole words only, so "linear_algebra" or "slackware" keep a monogram.
  const words = new Set(`${withoutConnectorPrefix(bare)} ${label.toLowerCase()}`.split(/[\s_.-]+/));
  const brand = BRAND_ICON_KINDS.find((kind) => words.has(kind));
  if (brand) return brand;
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

/** `interrupted` is a call still marked running on an idle thread: its completion was lost. */
export type McpCallDisplayStatus = "running" | "failed" | "interrupted" | "declined" | "completed";

/**
 * A card's accent: running wins, then any failure, then a lost completion, then
 * all-declined, else completed.
 */
export function mcpAggregateStatus(
  statuses: ReadonlyArray<McpCallDisplayStatus>,
): McpCallDisplayStatus {
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.length > 0 && statuses.every((status) => status === "declined")) {
    return "declined";
  }
  return "completed";
}
