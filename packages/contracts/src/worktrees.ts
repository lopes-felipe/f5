import { Schema } from "effect";
import { FilesystemPath, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas";

export const WorktreesInspectInput = Schema.Struct({ projectId: ProjectId, path: FilesystemPath });
export type WorktreesInspectInput = typeof WorktreesInspectInput.Type;
export const WorktreeRegistration = Schema.Struct({
  path: FilesystemPath,
  canonicalPath: FilesystemPath,
  headSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  bare: Schema.Boolean,
  detached: Schema.Boolean,
  locked: Schema.NullOr(Schema.String),
  prunable: Schema.NullOr(Schema.String),
  isMain: Schema.Boolean,
});
export const WorktreesInspectResult = Schema.Struct({
  exists: Schema.Boolean,
  registration: Schema.NullOr(WorktreeRegistration),
  blockedReasons: Schema.Array(Schema.String),
  linkedThreads: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, archived: Schema.Boolean }),
  ),
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
export const WorktreesRemoveInput = Schema.Struct({
  ...WorktreesInspectInput.fields,
  deleteBranch: Schema.Boolean,
  expectedHead: Schema.NullOr(Schema.String),
});
export type WorktreesRemoveInput = typeof WorktreesRemoveInput.Type;
export const WorktreesRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  branchDeleted: Schema.Boolean,
  blockedReasons: Schema.Array(Schema.String),
});
export type WorktreesRemoveResult = typeof WorktreesRemoveResult.Type;
export const WorktreesThreadStateInput = Schema.Struct({ threadId: ThreadId });
export type WorktreesThreadStateInput = typeof WorktreesThreadStateInput.Type;
export const WorktreesThreadStateResult = Schema.Struct({
  worktreePath: Schema.NullOr(FilesystemPath),
  branch: Schema.NullOr(Schema.String),
  directoryExists: Schema.Boolean,
  registration: Schema.Literals(["none", "matching", "stale", "otherBranch"]),
  branchExists: Schema.Boolean,
  defaultBranch: Schema.NullOr(Schema.String),
});
export type WorktreesThreadStateResult = typeof WorktreesThreadStateResult.Type;
export const WorktreesRecoverInput = Schema.Struct({
  threadId: ThreadId,
  expectedQueueRevision: NonNegativeInt,
  action: Schema.Literals(["recreate", "recreateFromBase", "useProjectCheckout"]),
});
export type WorktreesRecoverInput = typeof WorktreesRecoverInput.Type;
export const WorktreesRecoverResult = WorktreesThreadStateResult;
export type WorktreesRecoverResult = typeof WorktreesRecoverResult.Type;
