import type { NativeApi } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";
import { readNativeApi } from "./nativeApi";
import {
  useWorktreeRemovalDialogStore,
  type WorktreeRemovalRow,
} from "./worktreeRemovalDialogStore";

/**
 * Removes the worktrees the server reports as safe to remove without asking:
 * a clean tree, no other user, and no ignored files beyond build and cache
 * output. The server checks all of it again under its locks, and the branch is
 * always kept. Anything else, or anything that fails, is left for the dialog.
 */
export async function removeSafeWorktrees(
  api: Pick<NativeApi, "worktrees">,
  rows: ReadonlyArray<WorktreeRemovalRow>,
): Promise<{ readonly removed: number; readonly remaining: ReadonlyArray<WorktreeRemovalRow> }> {
  let removed = 0;
  const remaining: WorktreeRemovalRow[] = [];
  for (const row of rows) {
    try {
      const inspection = await api.worktrees.inspect(row);
      if (inspection.safeToRemoveSilently) {
        const result = await api.worktrees.remove({
          ...row,
          deleteBranch: false,
          expectedHead: inspection.headSha,
          disposableIgnoredOnly: true,
        });
        if (result.removed) {
          // A folder that was already gone only had its registration cleared.
          if (inspection.exists) removed += 1;
          continue;
        }
      }
    } catch {
      // The dialog inspects again and shows the reason.
    }
    remaining.push(row);
  }
  return { removed, remaining };
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
  const { removed, remaining } = await removeSafeWorktrees(api, rows);
  if (removed > 0) {
    store.recordSilentRemovals(removed);
    toastManager.add({
      type: "success",
      title:
        removed === 1
          ? "Removed 1 worktree · branch kept"
          : `Removed ${removed} worktrees · branches kept`,
    });
  }
  return store.request(remaining);
}
