import { Schema } from "effect";
import { FilesystemPath, ProjectId } from "./baseSchemas";
import { WorktreeRegistration, WorktreeLinkedThreads } from "./worktreeRegistration";

// Keep inventory response schemas out of the browser's startup request-schema graph.
export const WorktreeListEntry = Schema.Struct({
  path: FilesystemPath,
  canonicalPath: FilesystemPath,
  registration: Schema.NullOr(WorktreeRegistration),
  branch: Schema.NullOr(Schema.String),
  classification: Schema.Literals(["projectCheckout", "managed", "external", "otherProfile"]),
  missing: Schema.Boolean,
  locked: Schema.Boolean,
  detached: Schema.Boolean,
  hasChanges: Schema.NullOr(Schema.Boolean),
  linkedThreads: WorktreeLinkedThreads,
});
export type WorktreeListEntry = typeof WorktreeListEntry.Type;
export const WorktreesListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: Schema.String,
      workspaceRoot: FilesystemPath,
      entries: Schema.Array(WorktreeListEntry),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type WorktreesListResult = typeof WorktreesListResult.Type;
