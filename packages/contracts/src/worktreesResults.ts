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
  /**
   * `matching`: this repository's worktree is at the recorded path, on any
   * branch. `stale`: registered but the folder is gone. `foreign`: the path
   * holds something that is not this repository's worktree.
   */
  registration: Schema.Literals(["none", "matching", "stale", "foreign"]),
  branchExists: Schema.Boolean,
  defaultBranch: Schema.NullOr(Schema.String),
});
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
