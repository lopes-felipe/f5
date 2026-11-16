import { Schema } from "effect";
import { FilesystemPath, ThreadId } from "./baseSchemas";
import { WorktreeRegistration, WorktreeLinkedThreads } from "./worktreeRegistration";
import {
  WorkspaceTransitionSnapshot,
  WorkspaceCheckoutIdentity,
} from "./worktreeTransitionSchemas";

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
    }),
  ),
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

export const WorktreesThreadStateResult = Schema.Struct({
  recovery: Schema.optional(Schema.Literals(["none", "running", "interrupted"])),
  worktreePath: Schema.NullOr(FilesystemPath),
  branch: Schema.NullOr(Schema.String),
  directoryExists: Schema.Boolean,
  registration: Schema.Literals(["none", "matching", "stale", "otherBranch"]),
  branchExists: Schema.Boolean,
  defaultBranch: Schema.NullOr(Schema.String),
  /** The branch the recorded worktree is actually on; null when detached or missing. */
  checkoutBranch: Schema.optional(Schema.NullOr(Schema.String)),
  /** The recorded checkout is intact and only switched branches. */
  branchDriftOnly: Schema.optional(Schema.Boolean),
  /** Uncommitted changes in a drifted checkout; null when unknown. */
  checkoutDirty: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /** The end-of-turn sync will re-record `checkoutBranch` for this thread. */
  followsCheckoutAtTurnEnd: Schema.optional(Schema.Boolean),
});
export type WorktreesThreadStateResult = typeof WorktreesThreadStateResult.Type;

export const WorktreesRecoverResult = WorktreesThreadStateResult;
export type WorktreesRecoverResult = typeof WorktreesRecoverResult.Type;

export const WorktreesGetTransitionResult = Schema.NullOr(WorkspaceTransitionSnapshot);

export const WorkspaceTransitionRecoveryPreview = Schema.Struct({
  transition: WorkspaceTransitionSnapshot,
  actual: Schema.NullOr(WorkspaceCheckoutIdentity),
  original: Schema.NullOr(WorkspaceCheckoutIdentity),
  projectCheckout: Schema.NullOr(WorkspaceCheckoutIdentity),
  acceptanceToken: Schema.String,
  canRetry: Schema.Boolean,
  blockedReasons: Schema.Array(Schema.String),
});
export type WorkspaceTransitionRecoveryPreview = typeof WorkspaceTransitionRecoveryPreview.Type;
