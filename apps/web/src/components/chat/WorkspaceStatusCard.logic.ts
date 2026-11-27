import type { ThreadWorkspaceStatus, WorktreesRecoverInput } from "@t3tools/contracts";

export type WorkspaceAttention = Extract<ThreadWorkspaceStatus, { kind: "attention" }>;
export type WorkspaceWorking = Extract<ThreadWorkspaceStatus, { kind: "working" }>;
export type WorkspaceAction = WorkspaceAttention["actions"][number];

/**
 * Whether the thread's workspace has something to say. `ready` and `dormant`
 * say nothing: a dormant worktree comes back on the next message.
 */
export function workspaceNeedsCard(
  status: ThreadWorkspaceStatus | null | undefined,
): status is WorkspaceAttention | WorkspaceWorking {
  return status?.kind === "working" || status?.kind === "attention";
}

export function workspaceIsWorking(
  status: ThreadWorkspaceStatus | null | undefined,
): status is WorkspaceWorking {
  return status?.kind === "working";
}

/** What is happening to the workspace right now, in the words the rest of the app uses. */
export function describeWorkspaceActivity(activity: WorkspaceWorking["activity"]): string {
  switch (activity) {
    case "creating":
      return "Setting up the worktree…";
    case "restoring":
      return "Restoring the worktree…";
    case "switching":
      return "Switching workspace…";
    case "moving":
      return "Moving this thread to a new worktree…";
  }
}

export const WORKSPACE_ACTION_LABELS: Record<WorkspaceAction, string> = {
  retry: "Try again",
  attach: "Continue there",
  newWorktree: "New worktree",
  useProjectFolder: "Continue in Local",
  discard: "Discard message",
};

/**
 * What to say where the Git actions would be while a thread's worktree folder
 * is not on disk. "Restores on send" is a promise, so it is made only when the
 * server says the next message brings the worktree back. When the user has to
 * decide first, the workspace status card says what; this only names the fact.
 */
export function describeMissingWorktree(
  status: ThreadWorkspaceStatus | null | undefined,
  archived: boolean,
): { label: string; title: string } {
  if (archived)
    return {
      label: "Worktree removed",
      title:
        "This thread's worktree was removed. Unarchive the thread and send a message to restore it.",
    };
  if (status?.kind === "dormant")
    return {
      label: "Worktree restores on send",
      title: "This thread's worktree was cleaned up. Your next message restores it.",
    };
  if (status?.kind === "working")
    return { label: "Restoring worktree…", title: "This thread's worktree is being restored." };
  return {
    label: "Worktree not on disk",
    title:
      status?.kind === "attention"
        ? "This thread's worktree is not on disk. Choose how to continue above the message box."
        : "This thread's worktree is not on disk.",
  };
}

/**
 * The message the workspace is holding back: the first one that has not
 * failed. This is the server's own rule for which message waits, so
 * "Discard message" removes that one and not a failed one listed before it.
 */
export function heldQueueItem<Item extends { readonly status: string }>(
  items: ReadonlyArray<Item>,
): Item | undefined {
  return items.find((item) => item.status !== "failed");
}

/**
 * The `worktrees.recover` action behind a button. Discarding is not a recovery:
 * it removes the waiting message from the queue instead.
 */
export function recoverActionFor(
  action: Exclude<WorkspaceAction, "discard">,
): WorktreesRecoverInput["action"] {
  return action === "retry" ? "restore" : action;
}
