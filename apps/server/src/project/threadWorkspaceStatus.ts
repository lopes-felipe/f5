import type {
  QueueReasonCode,
  ThreadWorkspaceStatus,
  WorkspaceTransitionSnapshot,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { stat } from "node:fs/promises";
import nodePath from "node:path";
import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { WorktreeSetupGateState } from "./Services/WorktreeSetupGate.ts";
import { canonicalWorkspace, isProjectOrManagedPath } from "./workspaceAttachment.ts";
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
  /** The branch is gone here but a remote still has it: start it again from that copy. */
  | { readonly kind: "fromRemote"; readonly base: string }
  /** The branch is gone everywhere: start it again from the default branch. */
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
  if (state.remoteBranch) return { kind: "fromRemote", base: state.remoteBranch };
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
  /** Asked only when another checkout holds the thread's branch; see `readBranchHolder`. */
  readonly holder: (path: string) => Effect.Effect<BranchHolder>;
}

export interface BranchHolder {
  /** F5 attaches threads only to the project folder and to worktrees it manages. */
  readonly attachable: boolean;
  /** How many other threads of the project already work in that folder. */
  readonly sharedWith: number;
}

/**
 * What "Continue there" needs to know about the checkout that holds a thread's
 * branch: whether a thread can be attached to it at all, and who it would be
 * shared with. A folder that cannot be read is not offered.
 */
export const readBranchHolder =
  (input: {
    /** Null where the server's folders are not known: only the project folder is offered then. */
    readonly config: ServerConfigShape | null;
    readonly project: { readonly id: string; readonly workspaceRoot: string };
    readonly threadId: string;
    readonly threads: ReadonlyArray<{
      readonly id: string;
      readonly projectId: string;
      readonly worktreePath: string | null;
      readonly deletedAt: string | null;
      readonly archivedAt: string | null;
    }>;
  }) =>
  (holder: string): Effect.Effect<BranchHolder> =>
    Effect.gen(function* () {
      const [target, root] = yield* Effect.all([
        canonicalWorkspace(holder),
        canonicalWorkspace(input.project.workspaceRoot),
      ]);
      const attachable =
        target === root ||
        (input.config !== null && (yield* isProjectOrManagedPath(input.config, root, target)));
      let sharedWith = 0;
      for (const thread of input.threads) {
        if (
          thread.id === input.threadId ||
          thread.projectId !== input.project.id ||
          thread.deletedAt !== null ||
          thread.archivedAt !== null
        )
          continue;
        if (thread.worktreePath === null) {
          if (target === root) sharedWith++;
          // The folder's name is compared first: resolving every thread's path is not needed.
        } else if (
          nodePath.basename(thread.worktreePath) === nodePath.basename(target) &&
          (yield* canonicalWorkspace(thread.worktreePath).pipe(
            Effect.orElseSucceed(() => null),
          )) === target
        )
          sharedWith++;
      }
      return { attachable, sharedWith };
    }).pipe(Effect.orElseSucceed(() => ({ attachable: false, sharedWith: 0 })));

const SETUP_FAILURES: ReadonlyArray<QueueReasonCode> = [
  "worktree_setup_failed",
  "worktree_setup_cancelled",
  "worktree_setup_cancelled_kept",
];
/** The queue is held because a worktree's setup failed or was cancelled. */
export const isSetupFailure = (reason: QueueReasonCode | null | undefined) =>
  reason != null && SETUP_FAILURES.includes(reason);

const switchActivity = (intent: WorkspaceTransitionIntent) =>
  intent === "move_to_new_worktree"
    ? ("moving" as const)
    : intent === "recreate" || intent === "recreate_from_base"
      ? ("restoring" as const)
      : ("switching" as const);

const samePath = (left: string, right: string) =>
  nodePath.resolve(left) === nodePath.resolve(right);

/** Whether a Git checkout is at the folder, by one `stat` and without running Git. */
const holdsCheckout = (folder: string) =>
  Effect.promise(() =>
    stat(nodePath.join(folder, ".git")).then(
      () => true,
      () => false,
    ),
  );

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
    if (!thread.worktreePath)
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
    // This runs for every queue snapshot, so the usual case asks Git nothing:
    // a checkout is at the folder and no send has stopped on it. What the
    // checkout holds is verified by the send itself, which stops here if it
    // is not this thread's worktree.
    if (!stopped && (yield* holdsCheckout(thread.worktreePath))) return ready;
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
      case "branchInUse": {
        const holder = yield* facts.holder(plan.at);
        // Continuing there shares the folder, so the card says with whom.
        const shared =
          holder.attachable && holder.sharedWith > 0
            ? `, which ${holder.sharedWith} other ${holder.sharedWith === 1 ? "thread uses" : "threads use"}`
            : "";
        return {
          kind: "attention",
          reason: "branch_in_use",
          message: `${thread.branch} is checked out in ${
            samePath(plan.at, project.workspaceRoot)
              ? "the project folder"
              : nodePath.basename(plan.at)
          }${shared}, so this thread's worktree cannot be restored on it.`,
          // A checkout F5 does not manage cannot take a thread: only a new worktree is offered.
          actions: holder.attachable ? ["attach", "newWorktree"] : ["newWorktree"],
        } as const;
      }
      case "impossible":
        return failed(plan.message);
      case "recreate":
      case "fromRemote":
      case "fromBase":
        // A send that stopped here already tried the automatic restore.
        return stopped
          ? failed(queue.pauseDetail ?? "The worktree could not be restored.")
          : ({ kind: "dormant", path: thread.worktreePath, branch: thread.branch } as const);
    }
  });
