import { Schema } from "effect";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  makeEntityId,
} from "./baseSchemas";
import { WorkflowStageDispatchCommandId } from "./workflowStageDispatch";
import { WorkflowModelSlot, WorkflowStepStatus } from "./planningWorkflow";
import { WorkflowArchiveRestorations } from "./workflowArchive";
import { WorkflowParticipantId } from "./workflowParticipants";

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

/**
 * One directed cross-review on a run with more than two investigators: the
 * owning investigator reviews `revieweeId`'s report. Two-investigator runs keep
 * using the single `crossReview*` fields instead.
 */
export const InvestigationCrossReview = Schema.Struct({
  revieweeId: WorkflowParticipantId,
  threadId: Schema.NullOr(ThreadId),
  status: InvestigationPhaseStatus,
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  messageId: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  dispatchCommandId: WorkflowStageDispatchCommandId,
  updatedAt: IsoDateTime,
});
export type InvestigationCrossReview = typeof InvestigationCrossReview.Type;

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
  investigationRetryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  crossReviewRetryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  selfReviewRetryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  investigationDispatchCommandId: WorkflowStageDispatchCommandId,
  crossReviewDispatchCommandId: WorkflowStageDispatchCommandId,
  selfReviewDispatchCommandId: WorkflowStageDispatchCommandId,
  /** Directed cross-reviews by this investigator; only on runs with more than two investigators. */
  crossReviews: Schema.optional(Schema.Array(InvestigationCrossReview)),
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
  retryCount: Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(() => 0)),
  dispatchCommandId: WorkflowStageDispatchCommandId,
  updatedAt: IsoDateTime,
});
export type InvestigationSynthesis = typeof InvestigationSynthesis.Type;

export const InvestigationWorkflow = Schema.Struct({
  id: InvestigationWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  templateId: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => "builtin.investigation.dual"),
  ),
  templateVersion: Schema.optional(Schema.Int).pipe(Schema.withDecodingDefault(() => 1)),
  problemPrompt: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  investigatorA: InvestigationInvestigator,
  investigatorB: InvestigationInvestigator,
  /** Investigators beyond A and B (C, D), in roster order. Omitted on two-investigator runs. */
  additionalInvestigators: Schema.optional(
    Schema.Array(InvestigationInvestigator).check(Schema.isMaxLength(2)),
  ),
  synthesis: InvestigationSynthesis,
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
export type InvestigationWorkflow = typeof InvestigationWorkflow.Type;
