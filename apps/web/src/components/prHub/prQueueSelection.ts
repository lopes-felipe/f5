import type { NativeApi, PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";

import { resolveMergeMethod, type PrMergeMethod } from "./mergeMethod";

/** Adds the key to the selection, or removes it when it is already there. */
export function togglePrSelection<Key>(selected: ReadonlySet<Key>, key: Key): Set<Key> {
  const next = new Set(selected);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Selects or clears several keys at once, as a section's checkbox does. */
export function setPrSelection<Key>(
  selected: ReadonlySet<Key>,
  keys: readonly Key[],
  on: boolean,
): Set<Key> {
  const next = new Set(selected);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/**
 * Shift-click: selects every row from the last one clicked to this one, in the order on
 * screen. Without a last row still on screen it selects just this one.
 */
export function selectPrRange<Key>(
  rows: readonly Key[],
  selected: ReadonlySet<Key>,
  anchor: Key | null,
  key: Key,
): Set<Key> {
  const from = anchor === null ? -1 : rows.indexOf(anchor);
  const to = rows.indexOf(key);
  if (from < 0 || to < 0) return new Set(selected).add(key);
  return setPrSelection(selected, rows.slice(Math.min(from, to), Math.max(from, to) + 1), true);
}

export type PrSelectionState = "none" | "some" | "all";

export function prSelectionState<Key>(
  keys: readonly Key[],
  selected: ReadonlySet<Key>,
): PrSelectionState {
  const count = keys.filter((key) => selected.has(key)).length;
  return count === 0 ? "none" : count === keys.length ? "all" : "some";
}

/** Drops keys that left the screen; the same set comes back when nothing was dropped. */
export function prunePrSelection<Key>(
  selected: ReadonlySet<Key>,
  rows: readonly Key[],
): ReadonlySet<Key> {
  if (selected.size === 0) return selected;
  const visible = new Set(rows);
  const kept = [...selected].filter((key) => visible.has(key));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** Merging is the one bulk step that cannot be undone, so one confirmation covers few. */
export const PR_BULK_MERGE_LIMIT = 10;

export interface PrBulkMergeItem {
  readonly pr: TrackedPullRequest;
  readonly method: PrMergeMethod | null;
  /** Why this pull request will be skipped, or null when it can be merged. */
  readonly blocked: string | null;
}

export interface PrBulkMergePlan {
  /** Ready pull requests of the selection, at most the limit, in queue order. */
  readonly items: readonly PrBulkMergeItem[];
  /** Ready pull requests left out because the selection has more than the limit. */
  readonly overLimit: number;
}

const isReadyToMerge = (pr: TrackedPullRequest) =>
  pr.section === "ready" && pr.state === "open" && pr.ignoredAt === null && !pr.isDraft;

/**
 * What "Merge ready" would do for a selection: only the pull requests in Ready to merge,
 * each with the method the single Merge dialog would start on. Other forges merge
 * through their own prepared operation, one at a time, so they are listed as skipped.
 */
export function prBulkMergePlan(
  selection: readonly TrackedPullRequest[],
  preferences: {
    readonly configured: PrMergeMethod | null | undefined;
    readonly lastUsed: Readonly<Record<string, PrMergeMethod>>;
  },
): PrBulkMergePlan {
  const ready = selection.filter(isReadyToMerge);
  return {
    items: ready.slice(0, PR_BULK_MERGE_LIMIT).map((pr) => {
      const method = resolveMergeMethod({
        configured: preferences.configured,
        lastUsed: preferences.lastUsed[`${pr.host}/${pr.repository.nameWithOwner}`],
        allowed: pr.allowedMergeMethods ?? [],
      });
      return {
        pr,
        method,
        blocked:
          pr.provider !== "github"
            ? "Merge it from its own page."
            : !pr.headRefOid
              ? "Its latest commit is not known yet."
              : !method
                ? "The repository's merge methods are not known yet."
                : null,
      };
    }),
    overLimit: Math.max(0, ready.length - PR_BULK_MERGE_LIMIT),
  };
}

export type PrBulkMergeResult =
  | { readonly state: "running" }
  | { readonly state: "merged"; readonly warning?: string }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "skipped"; readonly message: string };

/**
 * Merges the planned pull requests one after another with the same checks as the single
 * Merge dialog: the comparison is read again, and the merge is refused when the head is
 * no longer the commit that was listed. A failure is reported for its row and the run
 * goes on to the next one.
 */
export async function runPrBulkMerge(
  items: readonly PrBulkMergeItem[],
  api: Pick<NativeApi["prHub"], "getFiles" | "merge">,
  onResult: (key: PullRequestKey, result: PrBulkMergeResult) => void,
): Promise<void> {
  for (const { pr, method, blocked } of items) {
    if (blocked || !method) {
      onResult(pr.key, { state: "skipped", message: blocked ?? "No merge method is available." });
      continue;
    }
    onResult(pr.key, { state: "running" });
    try {
      const { comparison } = await api.getFiles({ key: pr.key, mode: "force" });
      if (!comparison) throw new Error("The forge did not provide the merge comparison.");
      if (comparison.headOid !== pr.headRefOid)
        throw new Error("New commits were pushed since it was listed. Review it before merging.");
      const merged = await api.merge({ url: pr.url, method, expectedComparison: comparison });
      onResult(pr.key, {
        state: "merged",
        ...(merged.actionWarning ? { warning: merged.actionWarning } : {}),
      });
    } catch (error) {
      onResult(pr.key, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
