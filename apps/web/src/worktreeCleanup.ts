import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import type { Thread } from "./types";

export function getOrphanedWorktreePathForThread(
  threads: readonly Thread[],
  threadId: Thread["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = targetThread.worktreePath?.trim();
  if (!targetWorktreePath) {
    return null;
  }

  // Removing a checkout affects every thread using it, even when stored paths differ.
  const targetKey = normalizeProjectPathForComparison(targetWorktreePath);
  const isShared = threads.some(
    (thread) =>
      thread.id !== threadId &&
      thread.worktreePath !== null &&
      normalizeProjectPathForComparison(thread.worktreePath) === targetKey,
  );

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  if (!worktreePath) {
    return worktreePath;
  }

  const normalized = worktreePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1] ?? "";
  return lastPart.length > 0 ? lastPart : worktreePath;
}
