import type { ThreadId } from "@t3tools/contracts";

import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { describeMissingWorktree } from "./WorkspaceStatusCard.logic";

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
  const status = useNextTurnQueueStore((state) =>
    threadId ? state.byThreadId[threadId]?.snapshot?.workspace : undefined,
  );
  const { label, title } = describeMissingWorktree(status, archived);
  return (
    <span className="inline-flex h-7 items-center px-2 text-xs text-muted-foreground" title={title}>
      {label}
    </span>
  );
}
