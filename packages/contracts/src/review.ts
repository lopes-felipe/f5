import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const ReviewDiffScope = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffScope = typeof ReviewDiffScope.Type;

export const ReviewPreviewDiffInput = Schema.Struct({
  threadId: ThreadId,
  scope: ReviewDiffScope,
  baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewPreviewDiffInput = typeof ReviewPreviewDiffInput.Type;

export const ReviewPreviewDiffSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  source: Schema.Struct({ kind: ReviewDiffScope }),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  headCommit: Schema.NullOr(TrimmedNonEmptyString),
  patch: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  truncationReason: Schema.NullOr(Schema.String),
});
export type ReviewPreviewDiffSuccess = typeof ReviewPreviewDiffSuccess.Type;

export const ReviewPreviewDiffErrorCode = Schema.Literals([
  "thread_not_found",
  "project_not_found",
  "workspace_invalid",
  "not_a_repository",
  "unborn_head",
  "detached_head",
  "missing_base",
  "invalid_ref",
  "too_many_untracked",
  "timeout",
  "cancelled",
  "git_failed",
]);
export type ReviewPreviewDiffErrorCode = typeof ReviewPreviewDiffErrorCode.Type;

export const ReviewPreviewDiffFailure = Schema.Struct({
  kind: Schema.Literal("error"),
  code: ReviewPreviewDiffErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ReviewPreviewDiffFailure = typeof ReviewPreviewDiffFailure.Type;

export const ReviewPreviewDiffResult = Schema.Union([
  ReviewPreviewDiffSuccess,
  ReviewPreviewDiffFailure,
]);
export type ReviewPreviewDiffResult = typeof ReviewPreviewDiffResult.Type;
