import type {
  WorktreesMoveThreadInput,
  WorktreesMoveThreadResult,
  WorktreesDiscardMovedChangesInput,
  WorktreesDiscardMovedChangesResult,
  ThreadId,
  WorkspaceTransitionSnapshot,
  WorktreesSwitchWorkspaceInput,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/** What a switch the user cancelled records as its reason; anything after it is why cleanup failed. */
export const WORKSPACE_SWITCH_CANCELLED = "The workspace switch was cancelled.";
/** Whether a switch ended because the user cancelled it, and not because it failed. */
export const switchWasCancelled = (
  snapshot: Pick<WorkspaceTransitionSnapshot, "phase" | "error">,
) =>
  snapshot.phase === "cancelled" && snapshot.error?.startsWith(WORKSPACE_SWITCH_CANCELLED) === true;

export interface WorkspaceTransitionShape {
  readonly moveThread: (
    input: WorktreesMoveThreadInput,
  ) => Effect.Effect<WorktreesMoveThreadResult, Error>;
  readonly discardMovedChanges: (
    input: WorktreesDiscardMovedChangesInput,
  ) => Effect.Effect<WorktreesDiscardMovedChangesResult, Error>;
  /**
   * Runs a switch to its end. A switch that fails, is cancelled or is cut off by
   * a restart settles itself to done or not done, so the result is always a
   * terminal phase and nothing is left for the user to resolve.
   */
  readonly switchWorkspace: (
    input: WorktreesSwitchWorkspaceInput,
    setupOwnerToken?: string,
  ) => Effect.Effect<WorkspaceTransitionSnapshot, Error>;
  /** The thread's latest switch. One that nobody is running any more is settled first. */
  readonly getTransition: (input: {
    threadId: ThreadId;
  }) => Effect.Effect<WorkspaceTransitionSnapshot | null, Error>;
  /** Stops a running switch and settles it. The thread stays in its old or its new workspace. */
  readonly cancel: (threadId: ThreadId) => Effect.Effect<void, Error>;
}
export class WorkspaceTransition extends ServiceMap.Service<
  WorkspaceTransition,
  WorkspaceTransitionShape
>()("t3/project/Services/WorkspaceTransition") {}
