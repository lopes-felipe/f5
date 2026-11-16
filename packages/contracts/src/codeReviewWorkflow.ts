import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  makeEntityId,
} from "./baseSchemas";
import { WorkflowModelSlot, WorkflowStepStatus } from "./planningWorkflow";
import { WorkflowArchiveRestorations } from "./workflowArchive";

/**
 * The `thread.turn.start` command that began a stage's current attempt. Only
 * that command's turn may complete the stage; absent on stages recorded
 * before this field existed, which keep the older any-finished-turn rule.
 */
export const WorkflowStageDispatchCommandId = Schema.optional(Schema.NullOr(CommandId));

export const CodeReviewWorkflowId = makeEntityId("CodeReviewWorkflowId");
export type CodeReviewWorkflowId = typeof CodeReviewWorkflowId.Type;

export const ConsolidationStatus = Schema.Literals([
  "not_started",
  "pending_start",
  "running",
  "completed",
  "error",
]);
export type ConsolidationStatus = typeof ConsolidationStatus.Type;

export const CodeReviewReviewer = Schema.Struct({
  label: TrimmedNonEmptyString,
  slot: WorkflowModelSlot,
  threadId: ThreadId,
  status: WorkflowStepStatus,
  pinnedTurnId: Schema.NullOr(TrimmedNonEmptyString),
  pinnedAssistantMessageId: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  dispatchCommandId: WorkflowStageDispatchCommandId,
  updatedAt: IsoDateTime,
});
export type CodeReviewReviewer = typeof CodeReviewReviewer.Type;

export const CodeReviewConsolidation = Schema.Struct({
  slot: WorkflowModelSlot,
  threadId: Schema.NullOr(ThreadId),
  status: ConsolidationStatus,
  pinnedTurnId: Schema.NullOr(TrimmedNonEmptyString),
  pinnedAssistantMessageId: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  dispatchCommandId: WorkflowStageDispatchCommandId,
  updatedAt: IsoDateTime,
});
export type CodeReviewConsolidation = typeof CodeReviewConsolidation.Type;

/**
 * The pull request a code review targets, resolved once when the workflow is
 * created. `key` is the provider-qualified PR Hub key (`github:host/owner/repo#n`).
 */
export const CodeReviewPullRequest = Schema.Struct({
  url: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type CodeReviewPullRequest = typeof CodeReviewPullRequest.Type;

export const CodeReviewPostStatus = Schema.Literals([
  "posting",
  "posted",
  "failed",
  "needs_recovery",
]);
export type CodeReviewPostStatus = typeof CodeReviewPostStatus.Type;

/** Delivery of the merged review to the pull request as a timeline comment. */
export const CodeReviewPost = Schema.Struct({
  trigger: Schema.Literals(["auto", "manual"]),
  status: CodeReviewPostStatus,
  /** PR Hub comment operation id; reused on resume so a restart never resends. */
  operationId: TrimmedNonEmptyString,
  /** The consolidation turn whose merged review this post delivers. */
  consolidationTurnId: Schema.NullOr(TrimmedNonEmptyString),
  commentUrl: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type CodeReviewPost = typeof CodeReviewPost.Type;

export const CodeReviewWorkflow = Schema.Struct({
  id: CodeReviewWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  templateId: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => "builtin.code-review.dual"),
  ),
  templateVersion: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(() => 1)),
  reviewPrompt: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  pullRequest: Schema.optional(Schema.NullOr(CodeReviewPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  autoPost: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  post: Schema.optional(Schema.NullOr(CodeReviewPost)).pipe(Schema.withDecodingDefault(() => null)),
  reviewerA: CodeReviewReviewer,
  reviewerB: CodeReviewReviewer,
  consolidation: CodeReviewConsolidation,
  totalCostUsd: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  maxCostUsd: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  archiveRestorations: WorkflowArchiveRestorations,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type CodeReviewWorkflow = typeof CodeReviewWorkflow.Type;

export type DerivedCodeReviewWorkflowStatus =
  | "pending"
  | "reviewing"
  | "reviews_complete"
  | "pending_consolidation"
  | "consolidating"
  | "completed"
  | "error";

export function deriveCodeReviewWorkflowStatus(
  workflow: Pick<CodeReviewWorkflow, "reviewerA" | "reviewerB" | "consolidation">,
): DerivedCodeReviewWorkflowStatus {
  if (
    workflow.reviewerA.status === "error" ||
    workflow.reviewerB.status === "error" ||
    workflow.consolidation.status === "error"
  ) {
    return "error";
  }
  if (workflow.consolidation.status === "completed") {
    return "completed";
  }
  if (workflow.consolidation.status === "running") {
    return "consolidating";
  }
  if (workflow.consolidation.status === "pending_start") {
    return "pending_consolidation";
  }
  if (workflow.reviewerA.status === "completed" && workflow.reviewerB.status === "completed") {
    return "reviews_complete";
  }
  if (workflow.reviewerA.status === "running" || workflow.reviewerB.status === "running") {
    return "reviewing";
  }
  return "pending";
}
