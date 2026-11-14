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
  // Keyed by URL, so they cannot be matched to a pull request key.
  if (kind === "peek" || kind === "linkedPanel") return true;
  return queryKey
    .slice(2)
    .some((part) =>
      typeof part === "string"
        ? batch.keys.has(part)
        : Array.isArray(part) &&
          part.some((entry) => typeof entry === "string" && batch.keys.has(entry)),
    );
}
