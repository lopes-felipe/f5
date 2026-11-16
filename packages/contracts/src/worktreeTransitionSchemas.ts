import { Schema } from "effect";
import { FilesystemPath, NonNegativeInt, ThreadId } from "./baseSchemas";
import { GitCheckoutConflict } from "./git";

export const WorkspaceTransitionIntent = Schema.Literals([
  "move_to_new_worktree",
  "attach_existing",
  "checkout_branch",
  "create_branch_and_checkout",
  "use_project_checkout",
  "recreate",
  "recreate_from_base",
]);

export const WorkspaceTransitionPhase = Schema.Literals([
  "reserved",
  "stopping",
  "applying",
  "applied",
  "needs_recovery",
  "completed",
  "failed",
  "cancelled",
]);

export const WorkspaceExpectedContext = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(FilesystemPath),
  sessionUpdatedAt: Schema.NullOr(Schema.String),
});

export const WorkspaceCheckoutIdentity = Schema.Struct({
  path: FilesystemPath,
  repository: FilesystemPath,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
});
export type WorkspaceCheckoutIdentity = typeof WorkspaceCheckoutIdentity.Type;

export const WorkspaceTransitionSnapshot = Schema.Struct({
  move: Schema.optional(
    Schema.Struct({ copiedFileCount: NonNegativeInt, discarded: Schema.Boolean }),
  ),
  errorCode: Schema.optional(Schema.Literal("WorkspaceRequiresNewWorktree")),
  checkoutConflict: Schema.optional(GitCheckoutConflict),
  operationId: Schema.String,
  threadId: ThreadId,
  version: NonNegativeInt,
  intent: WorkspaceTransitionIntent,
  phase: WorkspaceTransitionPhase,
  source: WorkspaceCheckoutIdentity,
  target: WorkspaceCheckoutIdentity,
  observed: Schema.NullOr(WorkspaceCheckoutIdentity),
  error: Schema.NullOr(Schema.String),
  result: Schema.NullOr(WorkspaceExpectedContext),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceTransitionSnapshot = typeof WorkspaceTransitionSnapshot.Type;
