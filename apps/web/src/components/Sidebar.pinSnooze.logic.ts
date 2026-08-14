import type { ThreadId } from "@t3tools/contracts";

import { isSnoozedThread, sortThreadsByActivity } from "../lib/threadOrdering";
import type { Thread } from "../types";

export function orderActiveSidebarThreads(input: {
  readonly threads: ReadonlyArray<Thread>;
  readonly draftThreadId: ThreadId | null;
}): Thread[] {
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

export function projectSnoozedThreads(
  threads: ReadonlyArray<Thread>,
  projectId: Thread["projectId"],
): Thread[] {
  return sortThreadsByActivity(
    threads.filter(
      (thread) =>
        thread.projectId === projectId && thread.archivedAt === null && isSnoozedThread(thread),
    ),
  );
}
