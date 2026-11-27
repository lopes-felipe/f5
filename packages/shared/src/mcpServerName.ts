/**
 * MCP server-name helpers with no schema dependencies. Startup code such as
 * provider options imports these directly, so it does not pull MCP validation
 * and config merging into the web app's initial bundle.
 */
export const MAX_SERVER_NAME_LENGTH = 128;

export function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function mcpServerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Lenient check used for stored names, so legacy entries keep working. */
export function normalizeServerName(name: string): string | undefined {
  const trimmed = trimToUndefined(name);
  return trimmed && trimmed.length <= MAX_SERVER_NAME_LENGTH ? trimmed : undefined;
}

/**
 * New and renamed servers must use this charset. Tool names are built as
 * `mcp__<server>__<tool>` and Claude rewrites anything else, so two names
 * such as `a.b` and `a b` would otherwise collide.
 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const RESERVED_SERVER_NAME_PREFIXES = ["f5_", "__f5"] as const;

export const MCP_SERVER_NAME_RULE =
  "Server names may use letters, numbers, '_' and '-' (up to 128 characters) and must not start with 'f5_' or '__f5'.";

function hasReservedPrefix(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_SERVER_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Returns why a new or renamed server name is not allowed, or undefined when it is. */
export function readMcpServerNameProblem(name: string): string | undefined {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) return MCP_SERVER_NAME_RULE;
  if (hasReservedPrefix(name)) return MCP_SERVER_NAME_RULE;
  return undefined;
}

export function isValidNewMcpServerName(name: string): boolean {
  return readMcpServerNameProblem(name) === undefined;
}

/** Proposes a name that satisfies the rule, for import previews and rename hints. */
export function sanitizeMcpServerName(name: string): string {
  let next = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/_{2,}/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (hasReservedPrefix(next)) next = `mcp_${next.replace(/^_+/u, "")}`;
  if (!next) next = "server";
  return next.slice(0, MAX_SERVER_NAME_LENGTH);
}
