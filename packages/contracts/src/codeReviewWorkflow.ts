import { Schema } from "effect";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  makeEntityId,
} from "./baseSchemas";
import { WorkflowModelSlot, WorkflowStepStatus } from "./planningWorkflow";

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
  updatedAt: IsoDateTime,
});
export type CodeReviewConsolidation = typeof CodeReviewConsolidation.Type;

export const CodeReviewWorkflow = Schema.Struct({
  id: CodeReviewWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  reviewPrompt: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  reviewerA: CodeReviewReviewer,
  reviewerB: CodeReviewReviewer,
  consolidation: CodeReviewConsolidation,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
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
