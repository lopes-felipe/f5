import { Schema } from "effect";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  makeEntityId,
} from "./baseSchemas";
import { WorkflowModelSlot, WorkflowStepStatus } from "./planningWorkflow";

export const InvestigationWorkflowId = makeEntityId("InvestigationWorkflowId");
export type InvestigationWorkflowId = typeof InvestigationWorkflowId.Type;

export const InvestigationPhaseStatus = Schema.Literals([
  "not_started",
  "pending_start",
  "running",
  "completed",
  "error",
]);
export type InvestigationPhaseStatus = typeof InvestigationPhaseStatus.Type;

export const InvestigationInvestigator = Schema.Struct({
  label: TrimmedNonEmptyString,
  slot: WorkflowModelSlot,
  investigationThreadId: ThreadId,
  investigationStatus: WorkflowStepStatus,
  investigationTurnId: Schema.NullOr(TrimmedNonEmptyString),
  investigationMessageId: Schema.NullOr(TrimmedNonEmptyString),
  crossReviewThreadId: Schema.NullOr(ThreadId),
  crossReviewStatus: InvestigationPhaseStatus,
  crossReviewTurnId: Schema.NullOr(TrimmedNonEmptyString),
  crossReviewMessageId: Schema.NullOr(TrimmedNonEmptyString),
  selfReviewThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  selfReviewStatus: InvestigationPhaseStatus.pipe(
    Schema.withDecodingDefault(() => "not_started" as const),
  ),
  selfReviewTurnId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  selfReviewMessageId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type InvestigationInvestigator = typeof InvestigationInvestigator.Type;

export const InvestigationSynthesis = Schema.Struct({
  slot: WorkflowModelSlot,
  threadId: Schema.NullOr(ThreadId),
  status: InvestigationPhaseStatus,
  pinnedTurnId: Schema.NullOr(TrimmedNonEmptyString),
  pinnedAssistantMessageId: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type InvestigationSynthesis = typeof InvestigationSynthesis.Type;

export const InvestigationWorkflow = Schema.Struct({
  id: InvestigationWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  problemPrompt: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  investigatorA: InvestigationInvestigator,
  investigatorB: InvestigationInvestigator,
  synthesis: InvestigationSynthesis,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type InvestigationWorkflow = typeof InvestigationWorkflow.Type;

export type DerivedInvestigationWorkflowStatus =
  | "pending"
  | "investigating"
  | "investigations_complete"
  | "cross_reviewing"
  | "cross_reviews_complete"
  | "self_reviewing"
  | "self_reviews_complete"
  | "pending_synthesis"
  | "synthesizing"
  | "completed"
  | "error";

export function deriveInvestigationWorkflowStatus(
  workflow: Pick<
    InvestigationWorkflow,
    "investigatorA" | "investigatorB" | "selfReviewEnabled" | "synthesis"
  >,
): DerivedInvestigationWorkflowStatus {
  if (
    workflow.investigatorA.investigationStatus === "error" ||
    workflow.investigatorB.investigationStatus === "error" ||
    workflow.investigatorA.crossReviewStatus === "error" ||
    workflow.investigatorB.crossReviewStatus === "error" ||
    workflow.investigatorA.selfReviewStatus === "error" ||
    workflow.investigatorB.selfReviewStatus === "error" ||
    workflow.synthesis.status === "error"
  ) {
    return "error";
  }
  if (workflow.synthesis.status === "completed") {
    return "completed";
  }
  if (workflow.synthesis.status === "running") {
    return "synthesizing";
  }
  if (workflow.synthesis.status === "pending_start") {
    return "pending_synthesis";
  }
  const crossReviewsComplete =
    workflow.investigatorA.crossReviewStatus === "completed" &&
    workflow.investigatorB.crossReviewStatus === "completed";
  const selfReviewsComplete =
    workflow.investigatorA.selfReviewStatus === "completed" &&
    workflow.investigatorB.selfReviewStatus === "completed";
  if (crossReviewsComplete && workflow.selfReviewEnabled && selfReviewsComplete) {
    return "self_reviews_complete";
  }
  if (
    workflow.investigatorA.crossReviewStatus === "pending_start" ||
    workflow.investigatorB.crossReviewStatus === "pending_start" ||
    workflow.investigatorA.crossReviewStatus === "running" ||
    workflow.investigatorB.crossReviewStatus === "running"
  ) {
    return "cross_reviewing";
  }
  if (
    workflow.selfReviewEnabled &&
    (workflow.investigatorA.selfReviewStatus === "pending_start" ||
      workflow.investigatorB.selfReviewStatus === "pending_start" ||
      workflow.investigatorA.selfReviewStatus === "running" ||
      workflow.investigatorB.selfReviewStatus === "running" ||
      crossReviewsComplete)
  ) {
    return "self_reviewing";
  }
  if (crossReviewsComplete) {
    return "cross_reviews_complete";
  }
  if (
    workflow.investigatorA.investigationStatus === "completed" &&
    workflow.investigatorB.investigationStatus === "completed"
  ) {
    return "investigations_complete";
  }
  if (
    workflow.investigatorA.investigationStatus === "running" ||
    workflow.investigatorB.investigationStatus === "running"
  ) {
    return "investigating";
  }
  return "pending";
}
