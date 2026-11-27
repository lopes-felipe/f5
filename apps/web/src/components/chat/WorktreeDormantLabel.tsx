import type { ThreadId } from "@t3tools/contracts";

import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";

/**
 * Stands where the Git actions would be while a thread's worktree folder is
 * not on disk. There is nothing to click: the next message restores it, and
 * the workspace status card speaks up if that needs a decision.
 */
export function WorktreeDormantLabel({
  threadId,
  isServerThread,
}: {
  threadId: ThreadId | null;
  isServerThread: boolean;
}) {
  const archived = useStore((state) =>
    isServerThread && threadId ? Boolean(selectThreadById(state, threadId)?.archivedAt) : false,
  );
  return (
    <span
      className="inline-flex h-7 items-center px-2 text-xs text-muted-foreground"
      title={
        archived
          ? "This thread's worktree was removed. Unarchive the thread and send a message to restore it."
          : "This thread's worktree was cleaned up. Your next message restores it."
      }
    >
      {archived ? "Worktree removed" : "Worktree restores on send"}
    </span>
  );
}
