import { Schema } from "effect";
import { FilesystemPath, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas";
import { WorkspaceExpectedContext, WorkspaceTransitionIntent } from "./worktreeTransitionSchemas";
export { WorktreeRegistration } from "./worktreeRegistration";
export * from "./worktreeTransitionSchemas";
export * from "./worktreesResults";
export * from "./worktreesInventory";

export const WorktreesInspectInput = Schema.Struct({ projectId: ProjectId, path: FilesystemPath });
export type WorktreesInspectInput = typeof WorktreesInspectInput.Type;

export const WorktreesRemoveInput = Schema.Struct({
  ...WorktreesInspectInput.fields,
  deleteBranch: Schema.Boolean,
  expectedHead: Schema.NullOr(Schema.String),
  // A complete listing is capped at 64 KiB, including a NUL after each nonempty path.
  approvedIgnoredEntries: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(65_535))).check(Schema.isMaxLength(32_768)),
  ),
});
export type WorktreesRemoveInput = typeof WorktreesRemoveInput.Type;

export const WorktreesThreadStateInput = Schema.Struct({ threadId: ThreadId });
export type WorktreesThreadStateInput = typeof WorktreesThreadStateInput.Type;

export const WorktreesRecoverInput = Schema.Struct({
  threadId: ThreadId,
  expectedQueueRevision: NonNegativeInt,
  action: Schema.Literals([
    "recreate",
    "recreateFromBase",
    "useProjectCheckout",
    "cancel",
    "adoptCheckoutBranch",
    "restoreRecordedBranch",
  ]),
});
export type WorktreesRecoverInput = typeof WorktreesRecoverInput.Type;

export const WorktreesSwitchWorkspaceInput = Schema.Struct({
  operationId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  threadId: ThreadId,
  expected: WorkspaceExpectedContext,
  intent: WorkspaceTransitionIntent,
  targetPath: Schema.optional(FilesystemPath),
  branch: Schema.optional(Schema.NonEmptyString),
  sharedFilesystemConfirmed: Schema.optional(Schema.Boolean),
});
export type WorktreesSwitchWorkspaceInput = typeof WorktreesSwitchWorkspaceInput.Type;

export const WorktreesGetTransitionInput = WorktreesThreadStateInput;
export type WorktreesGetTransitionInput = typeof WorktreesGetTransitionInput.Type;

export const WorktreesPreviewTransitionRecoveryInput = Schema.Struct({
  operationId: Schema.String,
});
export type WorktreesPreviewTransitionRecoveryInput =
  typeof WorktreesPreviewTransitionRecoveryInput.Type;

export const WorktreesResolveTransitionInput = Schema.Struct({
  operationId: Schema.String,
  version: NonNegativeInt,
  acceptanceToken: Schema.String,
  action: Schema.Literals([
    "accept_inspected_workspace",
    "keep_original_workspace",
    "use_project_checkout",
    "retry",
  ]),
});
export type WorktreesResolveTransitionInput = typeof WorktreesResolveTransitionInput.Type;

/** Inventory is informational; every mutation revalidates identity and claims. */

export const WorktreesListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type WorktreesListInput = typeof WorktreesListInput.Type;

export const WorktreesMoveThreadInput = Schema.Struct({
  threadId: ThreadId,
  branch: Schema.optional(Schema.NonEmptyString),
});
export type WorktreesMoveThreadInput = typeof WorktreesMoveThreadInput.Type;
export const WorktreesMoveThreadResult = Schema.Struct({
  operationId: Schema.String,
  branch: Schema.String,
  worktreePath: FilesystemPath,
  copiedFileCount: NonNegativeInt,
});
export type WorktreesMoveThreadResult = typeof WorktreesMoveThreadResult.Type;
export const WorktreesDiscardMovedChangesInput = Schema.Struct({
  threadId: ThreadId,
  operationId: Schema.String,
});
export type WorktreesDiscardMovedChangesInput = typeof WorktreesDiscardMovedChangesInput.Type;
export const WorktreesDiscardMovedChangesResult = Schema.Struct({ discarded: Schema.Boolean });
export type WorktreesDiscardMovedChangesResult = typeof WorktreesDiscardMovedChangesResult.Type;
