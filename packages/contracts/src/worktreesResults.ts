import { Schema } from "effect";
import { FilesystemPath, ThreadId } from "./baseSchemas";
import { WorktreeRegistration, WorktreeLinkedThreads } from "./worktreeRegistration";
import { WorkspaceTransitionSnapshot } from "./worktreeTransitionSchemas";

// Responses stay separate from request schemas so the web startup can omit them.
export const WorktreesInspectResult = Schema.Struct({
  exists: Schema.Boolean,
  registration: Schema.NullOr(WorktreeRegistration),
  blockedReasons: Schema.Array(Schema.String),
  ignoredFiles: Schema.optional(
    Schema.Struct({
      entries: Schema.Array(Schema.String),
      truncated: Schema.Boolean,
      requiresApproval: Schema.Boolean,
      canRemoveAfterApproval: Schema.Boolean,
      /** Every entry is build or cache output of the kind automatic cleanup removes. */
      disposableOnly: Schema.Boolean,
    }),
  ),
  /**
   * Nothing here needs a person to look first: the tree is clean, no thread
   * that still exists uses the worktree, nothing blocks removal, and the only
   * ignored files are build or cache output. Removal checks all of it again.
   */
  safeToRemoveSilently: Schema.Boolean,
  linkedThreads: WorktreeLinkedThreads,
  deletedThreadClaims: Schema.Array(ThreadId),
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  branchExists: Schema.Boolean,
  branchMerged: Schema.Boolean,
  branchPushed: Schema.Boolean,
  branchUpstreamGone: Schema.Boolean,
  branchDeletable: Schema.Boolean,
  branchBlockedReason: Schema.NullOr(Schema.String),
});
export type WorktreesInspectResult = typeof WorktreesInspectResult.Type;

export const WorktreesRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  branchDeleted: Schema.Boolean,
  blockedReasons: Schema.Array(Schema.String),
});
export type WorktreesRemoveResult = typeof WorktreesRemoveResult.Type;

/**
 * What the user can do about a workspace that needs them. `retry` runs the
 * automatic restore again (or the failed setup), `attach` moves the thread to
 * the checkout that holds its branch, `newWorktree` gives it a fresh worktree,
 * `useProjectFolder` continues in the project folder and `discard` drops the
 * message a failed setup is holding.
 */
export const ThreadWorkspaceAction = Schema.Literals([
  "retry",
  "attach",
  "newWorktree",
  "useProjectFolder",
  "discard",
]);
export type ThreadWorkspaceAction = typeof ThreadWorkspaceAction.Type;

/**
 * The one answer to "what state is this thread's workspace in", computed on
 * the server. Every workspace surface renders this and nothing else.
 *
 * `branch` is the branch the thread records. Whether the folder is on it right
 * now, or on a detached HEAD, comes from live Git status, not from here.
 */
export const ThreadWorkspaceStatus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    location: Schema.Literals(["projectFolder", "worktree"]),
    path: FilesystemPath,
    branch: Schema.NullOr(Schema.String),
  }),
  /** The worktree's folder was cleaned up; the next message restores it. */
  Schema.Struct({
    kind: Schema.Literal("dormant"),
    path: FilesystemPath,
    branch: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("working"),
    activity: Schema.Literals(["creating", "restoring", "switching", "moving"]),
    cancellable: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("attention"),
    reason: Schema.Literals(["restore_failed", "setup_failed", "branch_in_use"]),
    message: Schema.String,
    /** The first action is the recommended one. */
    actions: Schema.Array(ThreadWorkspaceAction),
  }),
]);
export type ThreadWorkspaceStatus = typeof ThreadWorkspaceStatus.Type;

export const WorktreesThreadStateResult = ThreadWorkspaceStatus;
export type WorktreesThreadStateResult = typeof WorktreesThreadStateResult.Type;

export const InPlaceSwitchBlockerKind = Schema.Literals([
  "turn",
  "queued",
  "setup",
  "terminal",
  "session",
  "otherProfile",
  "unknown",
]);
export type InPlaceSwitchBlockerKind = typeof InPlaceSwitchBlockerKind.Type;

/** Informational only; every in-place switch rechecks under locks. */
export const WorktreesSwitchAvailabilityResult = Schema.Struct({
  blockers: Schema.Array(
    Schema.Struct({
      kind: InPlaceSwitchBlockerKind,
      threadId: Schema.NullOr(ThreadId),
      title: Schema.NullOr(Schema.String),
    }),
  ),
});
export type WorktreesSwitchAvailabilityResult = typeof WorktreesSwitchAvailabilityResult.Type;

export const WorktreesRecoverResult = WorktreesThreadStateResult;
export type WorktreesRecoverResult = typeof WorktreesRecoverResult.Type;

export const WorktreesGetTransitionResult = Schema.NullOr(WorkspaceTransitionSnapshot);
