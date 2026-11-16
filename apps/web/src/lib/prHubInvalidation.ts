import type { PrHubChanged } from "@t3tools/contracts";

/** What a burst of `prHub.changed` events asks the client to re-read. */
export interface PrHubChangeBatch {
  /** Re-read everything: the account or monitoring scope changed, or events were missed. */
  readonly resync: boolean;
  readonly keys: ReadonlySet<string>;
}

export const EMPTY_PR_HUB_CHANGE_BATCH: PrHubChangeBatch = { resync: false, keys: new Set() };

export function mergePrHubChange(batch: PrHubChangeBatch, event: PrHubChanged): PrHubChangeBatch {
  return {
    resync: batch.resync || event.resyncRequired,
    keys: new Set([...batch.keys, ...event.changedKeys, ...event.removedKeys]),
  };
}

/**
 * Notices `prHub.changed` events that never arrived. The server numbers them, and its
 * buffers drop the oldest under load. An event's changed keys are a difference from the
 * event before it, so after a gap the keys cannot be trusted and everything is re-read.
 */
export function createPrHubChangeSequence() {
  let last: number | undefined;
  return {
    /** The event, asking for a resync if one or more events before it were missed. */
    track(event: PrHubChanged): PrHubChanged {
      if (event.sequence === undefined) return event;
      const missed = last !== undefined && event.sequence !== last + 1;
      last = event.sequence;
      return missed ? { ...event, resyncRequired: true } : event;
    },
    /** A new connection or server starts counting again. */
    reset() {
      last = undefined;
    },
  };
}

/**
 * Whether a cached PR Hub read is stale after a batch. Collection reads always are. Reads
 * of one pull request are stale only when that pull request changed; before this, every
 * poll re-fetched the detail, timeline, files and threads of whichever PR was open.
 */
export function isPrHubQueryStale(queryKey: readonly unknown[], batch: PrHubChangeBatch): boolean {
  if (queryKey[0] !== "prHub") return false;
  if (batch.resync) return true;
  const kind = queryKey[1];
  if (kind === "overview" || kind === "list") return true;
  if (batch.keys.size === 0) return false;
  // Keyed by URL, so they cannot be matched to a pull request key. A stack spans several
  // pull requests: it changes when its parent or child merges, not only when its own row does.
  if (kind === "peek" || kind === "linkedPanel" || kind === "stack") return true;
  return queryKey
    .slice(2)
    .some((part) =>
      typeof part === "string"
        ? batch.keys.has(part)
        : Array.isArray(part) &&
          part.some((entry) => typeof entry === "string" && batch.keys.has(entry)),
    );
}
