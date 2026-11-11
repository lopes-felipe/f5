import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pure helpers for the shared-host phase of the Claude in Chrome live certification.
 * Kept out of the live test so the checks that decide each assertion are unit-tested.
 */

/** What one successful `tabs_context_mcp` call reported. */
export interface TabContext {
  /** Absent when the CLI's result carries no group id (it is optional in its format). */
  readonly tabGroupId?: number;
  readonly tabIds: ReadonlyArray<number>;
}

/** How one tab listing turn ended; recorded in the report so a failure says why. */
export type ListingOutcome =
  | "ok"
  | "ok-no-group-id"
  | "unreadable"
  | "tool-error"
  | "denied"
  | "not-called";

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
}

/**
 * Reads a `tabs_context_mcp` tool result: text content holding JSON with `availableTabs`
 * and, optionally, a numeric `tabGroupId` (the shape the CLI itself parses). Undefined
 * for anything else, so an unreadable result never counts as a routed call.
 */
export function parseTabContext(content: unknown): TabContext | undefined {
  for (const text of textsOf(content)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const { availableTabs, tabGroupId } = parsed as {
      availableTabs?: unknown;
      tabGroupId?: unknown;
    };
    if (!Array.isArray(availableTabs)) continue;
    const tabIds = availableTabs.flatMap((tab) =>
      typeof tab === "object" &&
      tab !== null &&
      typeof (tab as { tabId?: unknown }).tabId === "number"
        ? [(tab as { tabId: number }).tabId]
        : [],
    );
    return typeof tabGroupId === "number" ? { tabGroupId, tabIds } : { tabIds };
  }
  return undefined;
}

/** One `tool_result` for a tab listing in a turn. */
export interface ListingResult {
  readonly isError: boolean;
  readonly content: unknown;
}

/**
 * Classifies a listing turn from its tab-listing results. A denied call is reported by the
 * SDK as an error result carrying the permission callback's message.
 */
export function classifyListing(
  results: ReadonlyArray<ListingResult>,
  denialMessage: string,
): { readonly outcome: ListingOutcome; readonly context?: TabContext; readonly error?: string } {
  for (const result of results) {
    if (result.isError) continue;
    const context = parseTabContext(result.content);
    if (context)
      return { outcome: context.tabGroupId === undefined ? "ok-no-group-id" : "ok", context };
  }
  if (results.length === 0) return { outcome: "not-called" };
  const errors = results.filter((result) => result.isError);
  if (errors.length === 0) return { outcome: "unreadable" };
  const text = errors.flatMap((result) => textsOf(result.content)).join(" ");
  if (text.includes(denialMessage)) return { outcome: "denied" };
  return { outcome: "tool-error", error: scrubError(text) };
}

/** An error's first 200 characters with URLs removed, so no page address reaches the report. */
export function scrubError(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The native hosts serving CLIs right now: every `<pid>.sock` in the bridge folder whose
 * process is alive. A host listens on its own pid's socket and every CLI connects to all
 * of them, so a stale file left by a dead host is ignored.
 */
export async function liveBridgeHosts(
  dir: string,
  isAlive: (pid: number) => boolean,
): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const match = /^(\d+)\.sock$/.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .filter((pid) => isAlive(pid))
    .sort((a, b) => a - b);
}

export const bridgeSocketDir = (username: string) =>
  join("/tmp", `claude-mcp-browser-bridge-${username}`);

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `shared-host-survives-flip`: a host was serving before the second profile's launch
 * rewrote the manifests, the same hosts serve afterwards (the flip neither ended the
 * running host nor needed a new one), and the first session stayed connected.
 */
export function hostSurvivedFlip(input: {
  readonly hostsBefore: ReadonlyArray<number>;
  readonly hostsAfter: ReadonlyArray<number>;
  readonly manifestsFlipped: boolean;
  readonly firstStillConnected: boolean;
}): boolean {
  return (
    input.hostsBefore.length > 0 &&
    JSON.stringify(input.hostsBefore) === JSON.stringify(input.hostsAfter) &&
    input.manifestsFlipped &&
    input.firstStillConnected
  );
}

const sameTabs = (a: TabContext, b: TabContext) =>
  JSON.stringify([...a.tabIds].sort((x, y) => x - y)) ===
  JSON.stringify([...b.tabIds].sort((x, y) => x - y));

/**
 * Whether two listings from one session show the same group: the same group id when both
 * carry one, otherwise the same tabs (`createIfEmpty` adds a tab only to an empty group).
 */
export function sameGroup(a: TabContext | undefined, b: TabContext | undefined): boolean {
  if (!a || !b || a.tabIds.length === 0) return false;
  if (a.tabGroupId !== undefined && b.tabGroupId !== undefined)
    return a.tabGroupId === b.tabGroupId && sameTabs(a, b);
  return sameTabs(a, b);
}

/** Tabs two listings have in common. */
export function sharedTabCount(a: TabContext | undefined, b: TabContext | undefined): number {
  if (!a || !b) return 0;
  const other = new Set(b.tabIds);
  return a.tabIds.filter((tabId) => other.has(tabId)).length;
}

/**
 * `shared-calls-routed`: both sessions' concurrent calls succeeded, the first session
 * still sees the group it had before the flip, and the two groups differ: different ids
 * when both carry one, and no tab in common. A response delivered to the wrong session
 * would fail one call or show the other session's group.
 */
export function callsRouted(input: {
  readonly firstBeforeFlip: TabContext | undefined;
  readonly first: TabContext | undefined;
  readonly second: TabContext | undefined;
}): boolean {
  const { firstBeforeFlip, first, second } = input;
  if (!first || !second || second.tabIds.length === 0) return false;
  if (!sameGroup(firstBeforeFlip, first)) return false;
  if (
    first.tabGroupId !== undefined &&
    second.tabGroupId !== undefined &&
    first.tabGroupId === second.tabGroupId
  )
    return false;
  return sharedTabCount(first, second) === 0;
}
