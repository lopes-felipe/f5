import type { WorkspaceTransitionSnapshot } from "@t3tools/contracts";

const RUNNING_PHASES: ReadonlyArray<WorkspaceTransitionSnapshot["phase"]> = [
  "reserved",
  "stopping",
  "applying",
  "applied",
];

/**
 * Only a switch that is running right now holds a thread. One that failed, was
 * cancelled or was cut off settled itself on the server and needs nothing here.
 */
export function workspaceSwitchIsRunning(
  transition: WorkspaceTransitionSnapshot | null | undefined,
): transition is WorkspaceTransitionSnapshot {
  return !!transition && RUNNING_PHASES.includes(transition.phase);
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** What a running switch is doing, by branch or folder name; never a phase or a full path. */
export function describeWorkspaceSwitch(transition: WorkspaceTransitionSnapshot): string {
  switch (transition.intent) {
    case "move_to_new_worktree":
      return "Moving this thread to a new worktree…";
    case "use_project_checkout":
      return "Moving this thread to the project folder…";
    case "attach_existing":
      return `Switching to ${folderName(transition.target.path)}…`;
    case "checkout_branch":
    case "create_branch_and_checkout":
      return transition.target.branch
        ? `Switching to ${transition.target.branch}…`
        : "Switching branch…";
    case "recreate":
    case "recreate_from_base":
      return "Restoring the worktree…";
  }
}
