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
  | "browser-not-selected"
  | "not-called";

/** The CLI's "choose a browser" answer, which stands in for any browser call's result. */
export interface BrowserChoice {
  readonly connected: number;
  readonly local: number;
  /** The first browser listed under "Browsers on this computer"; never reported. */
  readonly localDeviceId?: string;
}

/**
 * Reads the CLI's browser-choice answer: when several Chrome browsers are connected to the
 * account and the session has selected none, every browser call returns it instead of
 * reaching Chrome. Undefined for anything else.
 */
export function parseBrowserChoice(content: unknown): BrowserChoice | undefined {
  const text = textsOf(content).join(" ");
  if (!text.includes("none has been selected for this session")) return undefined;
  const counts =
    /(\d+) Chrome browsers are connected to this account, (\d+) of them on this computer/.exec(
      text,
    );
  const deviceIds = [...text.matchAll(/deviceId: ([A-Za-z0-9_-]+)/g)];
  const localStart = text.indexOf("Browsers on this computer:");
  const localEnd = text.indexOf("Other connected browsers:");
  const localDeviceId =
    localStart === -1
      ? undefined
      : deviceIds.find(
          (match) => match.index > localStart && (localEnd === -1 || match.index < localEnd),
        )?.[1];
  return {
    connected: counts ? Number(counts[1]) : deviceIds.length,
    local: counts ? Number(counts[2]) : 0,
    ...(localDeviceId ? { localDeviceId } : {}),
  };
}

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
 * JSON object candidates in a text: the whole text, then each balanced `{…}` starting at
 * a `{"` (string-aware). The CLI returns the JSON and a readable listing as two blocks,
 * which a transcript may join into one string.
 */
function jsonCandidates(text: string): unknown[] {
  const found: unknown[] = [];
  const tryParse = (slice: string) => {
    try {
      found.push(JSON.parse(slice));
      return true;
    } catch {
      return false;
    }
  };
  if (tryParse(text.trim())) return found;
  let attempts = 0;
  for (let start = text.indexOf('{"'); start !== -1 && attempts < 50; ) {
    attempts += 1;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    tryParse(text.slice(start, end + 1));
    start = text.indexOf('{"', end + 1);
  }
  return found;
}

function fromJson(parsed: unknown): TabContext | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { availableTabs, tabGroupId } = parsed as {
    availableTabs?: unknown;
    tabGroupId?: unknown;
  };
  if (!Array.isArray(availableTabs)) return undefined;
  const tabIds = availableTabs.flatMap((tab) =>
    typeof tab === "object" &&
    tab !== null &&
    typeof (tab as { tabId?: unknown }).tabId === "number"
      ? [(tab as { tabId: number }).tabId]
      : [],
  );
  return typeof tabGroupId === "number" ? { tabGroupId, tabIds } : { tabIds };
}

/**
 * Reads a `tabs_context_mcp` tool result: JSON with `availableTabs` and, optionally, a
 * numeric `tabGroupId` (the shape the CLI itself parses), alone or joined with other
 * text. Falls back to the readable listing (`• tabId N: …` under "Available tabs"),
 * which carries no group id. Undefined for anything else, so an unreadable result never
 * counts as a routed call.
 */
export function parseTabContext(content: unknown): TabContext | undefined {
  const texts = textsOf(content);
  for (const text of texts)
    for (const candidate of jsonCandidates(text)) {
      const context = fromJson(candidate);
      if (context) return context;
    }
  for (const text of texts) {
    const at = text.indexOf("Available tabs:");
    if (at === -1) continue;
    const tabIds = [...text.slice(at).matchAll(/tabId (\d+):/g)].map((match) => Number(match[1]));
    return { tabIds };
  }
  return undefined;
}

/**
 * What a result looked like, without its content: for diagnosing an unreadable listing.
 */
export function resultShape(content: unknown): Record<string, unknown> {
  const texts = textsOf(content);
  return {
    kind:
      typeof content === "string" ? "string" : Array.isArray(content) ? "array" : typeof content,
    blocks: Array.isArray(content)
      ? content.map((block) =>
          typeof block === "object" && block !== null
            ? String((block as { type?: unknown }).type)
            : typeof block,
        )
      : undefined,
    textLength: texts.reduce((sum, text) => sum + text.length, 0),
    hasAvailableTabs: texts.some((text) => text.includes("availableTabs")),
    hasTabGroupId: texts.some((text) => text.includes("tabGroupId")),
    hasReadableListing: texts.some((text) => text.includes("Available tabs:")),
  };
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
): {
  readonly outcome: ListingOutcome;
  readonly context?: TabContext;
  readonly error?: string;
  readonly shape?: Record<string, unknown>;
  readonly choice?: BrowserChoice;
} {
  for (const result of results) {
    if (result.isError) continue;
    const context = parseTabContext(result.content);
    if (context)
      return { outcome: context.tabGroupId === undefined ? "ok-no-group-id" : "ok", context };
  }
  if (results.length === 0) return { outcome: "not-called" };
  // Flagged as an error by the CLI, though a transcript may not carry the flag.
  for (const result of results) {
    const choice = parseBrowserChoice(result.content);
    if (choice) return { outcome: "browser-not-selected", choice };
  }
  const errors = results.filter((result) => result.isError);
  if (errors.length === 0) {
    const text = textsOf(results[0]!.content).join(" ");
    return {
      outcome: "unreadable",
      shape: resultShape(results[0]!.content),
      error: scrubError(text),
    };
  }
  const text = errors.flatMap((result) => textsOf(result.content)).join(" ");
  if (text.includes(denialMessage)) return { outcome: "denied" };
  return { outcome: "tool-error", error: scrubError(text) };
}

/**
 * A message's first 200 characters with URLs, device ids and UUIDs removed, so no page
 * address or browser identity reaches the report.
 */
export function scrubError(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/deviceId: [A-Za-z0-9_-]+/g, "deviceId: <id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
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
