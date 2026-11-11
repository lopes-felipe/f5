import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pure helpers for the shared-host phase of the Claude in Chrome live certification.
 * Kept out of the live test so the checks that decide each assertion are unit-tested.
 */

/** What one successful `tabs_context_mcp` call reported. */
export interface TabContext {
  readonly tabGroupId: number;
  readonly tabIds: ReadonlyArray<number>;
}

/**
 * Reads a `tabs_context_mcp` tool result: text content holding JSON with `availableTabs`
 * and a numeric `tabGroupId` (the shape the CLI itself parses). Undefined for anything
 * else, so an unreadable result never counts as a routed call.
 */
export function parseTabContext(content: unknown): TabContext | undefined {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block) =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string"
              ? [(block as { text: string }).text]
              : [],
          )
        : [];
  for (const text of texts) {
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
    if (!Array.isArray(availableTabs) || typeof tabGroupId !== "number") continue;
    const tabIds = availableTabs.flatMap((tab) =>
      typeof tab === "object" &&
      tab !== null &&
      typeof (tab as { tabId?: unknown }).tabId === "number"
        ? [(tab as { tabId: number }).tabId]
        : [],
    );
    return { tabGroupId, tabIds };
  }
  return undefined;
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

/**
 * `shared-calls-routed`: both sessions' concurrent calls succeeded, each answered from a
 * different tab group with no tab in common, and the first session's group is the one it
 * had before the flip. A response delivered to the wrong session would fail one call or
 * show the other session's group.
 */
export function callsRouted(input: {
  readonly firstBeforeFlip: TabContext | undefined;
  readonly first: TabContext | undefined;
  readonly second: TabContext | undefined;
}): boolean {
  const { firstBeforeFlip, first, second } = input;
  if (!firstBeforeFlip || !first || !second) return false;
  if (first.tabIds.length === 0 || second.tabIds.length === 0) return false;
  const secondTabs = new Set(second.tabIds);
  return (
    first.tabGroupId === firstBeforeFlip.tabGroupId &&
    first.tabGroupId !== second.tabGroupId &&
    first.tabIds.every((tabId) => !secondTabs.has(tabId))
  );
}
