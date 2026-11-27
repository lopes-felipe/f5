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
 * The `worktrees.recover` action behind a button. Discarding is not a recovery:
 * it removes the waiting message from the queue instead.
 */
export function recoverActionFor(
  action: Exclude<WorkspaceAction, "discard">,
): WorktreesRecoverInput["action"] {
  return action === "retry" ? "restore" : action;
}
