import type {
  QueueReasonCode,
  ThreadWorkspaceStatus,
  WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Effect } from "effect";
import nodePath from "node:path";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { WorktreeSetupGateState } from "./Services/WorktreeSetupGate.ts";
import { readWorktreeState } from "./worktreeReadiness.ts";

type WorkspaceTransitionIntent = WorkspaceTransitionSnapshot["intent"];
type WorktreeState = Effect.Success<ReturnType<typeof readWorktreeState>>;

/**
 * How a worktree that is not ready comes back, decided from Git alone. The
 * status below and the `restore` action both follow it, so what the card says
 * will happen is what happens.
 */
export type RestorePlan =
  | { readonly kind: "none" }
  /** Put the recorded branch back in a worktree; at a new path if the folder is taken. */
  | { readonly kind: "recreate" }
  /** The branch is gone too: start it again from the default branch. */
  | { readonly kind: "fromBase"; readonly base: string }
  /** Git allows one checkout per branch, and another one has it. */
  | { readonly kind: "branchInUse"; readonly at: string }
  | { readonly kind: "impossible"; readonly message: string };

export const planRestore = (state: WorktreeState): RestorePlan => {
  if (state.registration === "matching") return { kind: "none" };
  if (state.grouped)
    return state.registration === "stale"
      ? { kind: "recreate" }
      : {
          kind: "impossible",
          message: "This thread's worktree spans several repositories and one of them changed.",
        };
  if (state.branch !== null && state.branchExists)
    return state.branchCheckedOutAt === null
      ? { kind: "recreate" }
      : { kind: "branchInUse", at: state.branchCheckedOutAt };
  if (state.defaultBranch) return { kind: "fromBase", base: state.defaultBranch };
  return {
    kind: "impossible",
    message: state.branch
      ? `This thread's worktree and ${state.branch} are gone, and the repository has no default branch to start again from.`
      : "This thread's worktree is gone and it recorded no branch to restore.",
  };
};

export interface ThreadWorkspaceFacts {
  readonly thread: { readonly worktreePath: string | null; readonly branch: string | null };
  readonly project: { readonly workspaceRoot: string };
  /** The switch that is running right now, if any. */
  readonly switching: WorkspaceTransitionIntent | null;
  /** The automatic restore has started and has not yet reserved its switch. */
  readonly restoring: boolean;
  readonly setup: WorktreeSetupGateState;
  readonly setupToken: string | null;
  readonly queue: {
    readonly paused: boolean;
    readonly pauseReasonCode: QueueReasonCode | null;
    readonly pauseDetail: string | null;
  };
}

const SETUP_FAILURES: ReadonlyArray<QueueReasonCode> = [
  "worktree_setup_failed",
  "worktree_setup_cancelled",
  "worktree_setup_cancelled_kept",
];

const switchActivity = (intent: WorkspaceTransitionIntent) =>
  intent === "move_to_new_worktree"
    ? ("moving" as const)
    : intent === "recreate" || intent === "recreate_from_base"
      ? ("restoring" as const)
      : ("switching" as const);

const samePath = (left: string, right: string) =>
  nodePath.resolve(left) === nodePath.resolve(right);

/**
 * The single place that decides what state a thread's workspace is in. It
 * merges the running switch, the setup gate, the queue pause and what Git says
 * about the recorded folder, in that order: whatever is happening right now
 * wins over what was found on disk.
 *
 * Never fails. A repository that cannot be read is reported only once a send
 * has stopped on it; until then the folder is assumed to be fine, because the
 * send retries the check before it gives up.
 */
export const deriveThreadWorkspaceStatus = (
  git: GitCoreShape,
  facts: ThreadWorkspaceFacts,
): Effect.Effect<ThreadWorkspaceStatus> =>
  Effect.gen(function* () {
    const { thread, project, queue } = facts;
    if (facts.switching !== null)
      return {
        kind: "working",
        activity: switchActivity(facts.switching),
        cancellable: true,
      } as const;
    if (facts.restoring)
      return { kind: "working", activity: "restoring", cancellable: false } as const;
    if (facts.setup === "gating") {
      // Preparing a worktree that was just recreated has nothing to cancel;
      // a first-send setup is cancelled from its own stage list.
      const background = facts.setupToken?.startsWith("preparation:") === true;
      return {
        kind: "working",
        activity: background ? "restoring" : "creating",
        cancellable: !background,
      } as const;
    }
    if (
      facts.setup === "orphaned" ||
      (queue.paused &&
        queue.pauseReasonCode !== null &&
        SETUP_FAILURES.includes(queue.pauseReasonCode))
    )
      return {
        kind: "attention",
        reason: "setup_failed",
        message: queue.pauseDetail ?? "Worktree setup did not finish.",
        actions: ["retry", "useProjectFolder", "discard"],
      } as const;
    if (thread.worktreePath === null)
      return {
        kind: "ready",
        location: "projectFolder",
        path: project.workspaceRoot,
        branch: thread.branch,
      } as const;
    const stopped = queue.paused && queue.pauseReasonCode === "worktree_missing";
    const failed = (message: string) =>
      ({
        kind: "attention",
        reason: "restore_failed",
        message,
        actions: ["retry", "useProjectFolder"],
      }) as const;
    const ready = {
      kind: "ready",
      location: "worktree",
      path: thread.worktreePath,
      branch: thread.branch,
    } as const;
    const state = yield* readWorktreeState(git, {
      projectCwd: project.workspaceRoot,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
    }).pipe(Effect.option);
    if (state._tag === "None")
      return stopped ? failed(queue.pauseDetail ?? "The worktree could not be checked.") : ready;
    const plan = planRestore(state.value);
    switch (plan.kind) {
      case "none":
        return ready;
      case "branchInUse":
        return {
          kind: "attention",
          reason: "branch_in_use",
          message: `${thread.branch} is checked out in ${
            samePath(plan.at, project.workspaceRoot)
              ? "the project folder"
              : nodePath.basename(plan.at)
          }, so this thread's worktree cannot be restored on it.`,
          actions: ["attach", "newWorktree"],
        } as const;
      case "impossible":
        return failed(plan.message);
      case "recreate":
      case "fromBase":
        // A send that stopped here already tried the automatic restore.
        return stopped
          ? failed(queue.pauseDetail ?? "The worktree could not be restored.")
          : ({ kind: "dormant", path: thread.worktreePath, branch: thread.branch } as const);
    }
  });
