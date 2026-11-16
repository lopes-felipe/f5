import type { ThreadId } from "@t3tools/contracts";

import { isSnoozedThread, sortThreadsByActivity } from "../lib/threadOrdering";
import type { Thread, ThreadListItem } from "../types";

export function orderActiveSidebarThreads<T extends ThreadListItem>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly draftThreadId: ThreadId | null;
}): T[] {
  return input.threads
    .filter((thread) => !isSnoozedThread(thread))
    .toSorted((left, right) => {
      if (left.id === input.draftThreadId) return -1;
      if (right.id === input.draftThreadId) return 1;
      const leftPinned = left.pinOrderKey != null;
      const rightPinned = right.pinOrderKey != null;
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) {
        return (left.pinOrderKey ?? 0) - (right.pinOrderKey ?? 0);
      }
      return 0;
    });
}

export function projectSnoozedThreads<T extends ThreadListItem>(
  threads: ReadonlyArray<T>,
  projectId: Thread["projectId"],
): T[] {
  return sortThreadsByActivity(
    threads.filter(
      (thread) =>
        thread.projectId === projectId && thread.archivedAt === null && isSnoozedThread(thread),
    ),
  );
}
