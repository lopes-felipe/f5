import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/**
 * Background worktree setup for a new thread's first send.
 *
 * The first send creates the thread, queues its turn at the head of the
 * thread's durable queue and returns. A setup fiber then fetches the base,
 * checks out the worktree, initializes submodules and runs the setup script
 * while the queue waits with `worktree_setup`. The latest snapshot is kept as
 * one thread activity (`worktree-setup:<threadId>`) so any client, or a reload,
 * can render the outcome; live progress is pushed on `worktreeSetup.updated`.
 */

/** Producers clamp free text to these before publishing so encoding never fails. */
export const WORKTREE_SETUP_DETAIL_MAX_LENGTH = 200;
export const WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH = 400;
export const WORKTREE_SETUP_ERROR_MAX_LENGTH = 1000;
/** The setup card shows this many trailing setup-script output lines. */
export const WORKTREE_SETUP_TAIL_LINES = 5;

export const WorktreeSetupStageId = Schema.Literals([
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
]);
export type WorktreeSetupStageId = typeof WorktreeSetupStageId.Type;

export const WORKTREE_SETUP_STAGE_ORDER: ReadonlyArray<WorktreeSetupStageId> = [
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
];

export const WorktreeSetupStageStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "skipped",
  "warning",
  "failed",
]);
export type WorktreeSetupStageStatus = typeof WorktreeSetupStageStatus.Type;

export const WorktreeSetupStage = Schema.Struct({
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  /** Only the checkout stage reports a real percentage, parsed from git's progress lines. */
  percent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Short trailing text for the row: a file count, an exit code, a submodule name. */
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_DETAIL_MAX_LENGTH))),
  /** Last setup-script output lines, ANSI stripped, newest last. */
  tail: Schema.Array(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH))),
});
export type WorktreeSetupStage = typeof WorktreeSetupStage.Type;

/**
 * `cancelled_kept`: setup was cancelled but the worktree (or branch) was kept
 * because it may contain changes, another claim exists, or git refused.
 */
export const WorktreeSetupPhase = Schema.Literals([
  "running",
  "done",
  "failed",
  "cancelled",
  "cancelled_kept",
]);
export type WorktreeSetupPhase = typeof WorktreeSetupPhase.Type;

/** What the first send asked for; enough to retry after a restart. */
export const WorktreeSetupRequest = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  runSetupScript: Schema.Boolean,
  requireWorktree: Schema.Boolean,
});
export type WorktreeSetupRequest = typeof WorktreeSetupRequest.Type;

export const WorktreeSetupSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** Changes on every retry, so stale cancels and stream updates can be told apart. */
  operationId: TrimmedNonEmptyString,
  /** The queued first turn this setup gates. */
  itemId: CommandId,
  phase: WorktreeSetupPhase,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  request: WorktreeSetupRequest,
  /** Resolved base: the fetched remote commit, or the local branch. */
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  /** Commit the new branch was created at; branch deletion requires it to be unchanged. */
  baseSha: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** True once this setup created the branch, so cancel may delete it. */
  createdBranch: Schema.Boolean,
  /** True once git registered the worktree directory for this setup. */
  createdWorktree: Schema.Boolean,
  setupScript: Schema.NullOr(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      /** False when the agent waits for the script to finish. */
      async: Schema.Boolean,
    }),
  ),
  /** True once the queued turn has been handed to the agent; cancel then stops the turn. */
  agentStarted: Schema.Boolean,
  stages: Schema.Array(WorktreeSetupStage),
  /** Human readable reason when phase is failed or cancelled_kept. */
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_ERROR_MAX_LENGTH))),
  sequence: NonNegativeInt,
});
export type WorktreeSetupSnapshot = typeof WorktreeSetupSnapshot.Type;

export const WORKTREE_SETUP_ACTIVITY_KIND = "worktree-setup";
export const worktreeSetupActivityId = (threadId: string) => `worktree-setup:${threadId}`;

export const WorktreeSetupThreadInput = Schema.Struct({ threadId: ThreadId });
export type WorktreeSetupThreadInput = typeof WorktreeSetupThreadInput.Type;

/** Null means no setup is tracked for that thread. */
export const WorktreeSetupSubscribeResult = Schema.NullOr(WorktreeSetupSnapshot);
export type WorktreeSetupSubscribeResult = typeof WorktreeSetupSubscribeResult.Type;

export const WorktreeSetupUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  snapshot: Schema.NullOr(WorktreeSetupSnapshot),
});
export type WorktreeSetupUpdatedPayload = typeof WorktreeSetupUpdatedPayload.Type;

export const WorktreeSetupActionResult = Schema.Struct({
  snapshot: Schema.NullOr(WorktreeSetupSnapshot),
});
export type WorktreeSetupActionResult = typeof WorktreeSetupActionResult.Type;

export function worktreeSetupStageLabel(id: WorktreeSetupStageId): string {
  switch (id) {
    case "fetch":
      return "Fetch base branch";
    case "checkout":
      return "Check out files";
    case "submodules":
      return "Initialize submodules";
    case "setup-script":
      return "Run setup script";
    case "agent":
      return "Start agent";
  }
}

/** Whether the snapshot still blocks the queued first turn from starting. */
export function worktreeSetupGatesTurn(snapshot: WorktreeSetupSnapshot): boolean {
  if (snapshot.phase !== "running" || snapshot.agentStarted) return false;
  const stage = (id: WorktreeSetupStageId) => snapshot.stages.find((entry) => entry.id === id);
  const agent = stage("agent");
  if (agent?.status === "running" || agent?.status === "done") return false;
  return true;
}
