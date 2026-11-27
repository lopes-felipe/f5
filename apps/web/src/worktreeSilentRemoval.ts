import type { NativeApi } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { readNativeApi } from "./nativeApi";
import {
  useWorktreeRemovalDialogStore,
  type WorktreeRemovalRow,
} from "./worktreeRemovalDialogStore";

/** Worktrees checked and removed at once: each one runs Git under the repository's lock. */
const SILENT_REMOVAL_CONCURRENCY = 4;

/**
 * Removes the worktrees the server reports as safe to remove without asking:
 * a clean tree, no thread that still uses it, and no ignored files beyond
 * build and cache output. `silent` makes the server check all of that again
 * under its locks, and the branch is always kept. Anything else, or anything
 * that fails, is left for the dialog.
 *
 * `removed` counts folders that were on disk. `cleared` also counts worktrees
 * whose folder was already gone and only had their registration cleared: the
 * lists that show worktrees changed for those too.
 */
export async function removeSafeWorktrees(
  api: Pick<NativeApi, "worktrees">,
  rows: ReadonlyArray<WorktreeRemovalRow>,
): Promise<{
  readonly removed: number;
  readonly cleared: number;
  readonly remaining: ReadonlyArray<WorktreeRemovalRow>;
}> {
  const settle = async (row: WorktreeRemovalRow) => {
    try {
      const inspection = await api.worktrees.inspect(row);
      if (inspection.safeToRemoveSilently) {
        const result = await api.worktrees.remove({
          ...row,
          deleteBranch: false,
          expectedHead: inspection.headSha,
          silent: true,
        });
        if (result.removed) return inspection.exists ? "removed" : "cleared";
      }
    } catch {
      // The dialog inspects again and shows the reason.
    }
    return "remaining";
  };
  // A few at a time, so deleting many threads does not hold the dialog back
  // for one worktree after another. The rows keep their order.
  const outcomes: Array<Awaited<ReturnType<typeof settle>>> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SILENT_REMOVAL_CONCURRENCY, rows.length) }, async () => {
      while (next < rows.length) {
        const index = next++;
        outcomes[index] = await settle(rows[index]!);
      }
    }),
  );
  const removed = outcomes.filter((outcome) => outcome === "removed").length;
  return {
    removed,
    cleared: removed + outcomes.filter((outcome) => outcome === "cleared").length,
    remaining: rows.filter((_, index) => outcomes[index] === "remaining"),
  };
}

/**
 * For worktrees whose threads were just deleted: removes the ones that are
 * safe to remove without asking, says so, and opens the removal dialog only
 * for the rest.
 */
export async function offerWorktreeRemovalAfterDeletion(
  rows: ReadonlyArray<WorktreeRemovalRow>,
): Promise<void> {
  const store = useWorktreeRemovalDialogStore.getState();
  const api = readNativeApi();
  if (!api || rows.length === 0) return store.request(rows);
  const { removed, cleared, remaining } = await removeSafeWorktrees(api, rows);
  // Open lists refresh for a cleared registration too; only folders are announced.
  if (cleared > 0) store.recordSilentRemovals(cleared);
  if (removed > 0)
    toastManager.add({
      type: "success",
      title:
        removed === 1
          ? "Removed 1 worktree · branch kept"
          : `Removed ${removed} worktrees · branches kept`,
    });
  return store.request(remaining);
}
