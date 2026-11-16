import { Schema } from "effect";
import { FilesystemPath, ThreadId } from "./baseSchemas";

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

export const WorktreeLinkedThreads = Schema.Array(
  Schema.Struct({ threadId: ThreadId, title: Schema.String, archived: Schema.Boolean }),
);
