import { Schema } from "effect";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  makeEntityId,
} from "./baseSchemas";
import { ProviderModelOptions } from "./model";
import { ProviderKind } from "./providerKind";

export const PlanningWorkflowId = makeEntityId("PlanningWorkflowId");
export type PlanningWorkflowId = typeof PlanningWorkflowId.Type;

export const WorkflowBranchId = Schema.Literals(["a", "b"]);
export type WorkflowBranchId = typeof WorkflowBranchId.Type;

export const WorkflowReviewSlot = Schema.Literals(["cross", "self"]);
export type WorkflowReviewSlot = typeof WorkflowReviewSlot.Type;

export const WorkflowBranchStatus = Schema.Literals([
  "pending",
  "authoring",
  "plan_saved",
  "reviews_requested",
  "reviews_saved",
  "revising",
  "revised",
  "error",
]);
export type WorkflowBranchStatus = typeof WorkflowBranchStatus.Type;

export const WorkflowMergeStatus = Schema.Literals([
  "not_started",
  "in_progress",
  "merged",
  "manual_review",
  "error",
]);
export type WorkflowMergeStatus = typeof WorkflowMergeStatus.Type;

export const WorkflowStepStatus = Schema.Literals(["pending", "running", "completed", "error"]);
export type WorkflowStepStatus = typeof WorkflowStepStatus.Type;

export const WorkflowImplementationStatus = Schema.Literals([
  "not_started",
  "implementing",
  "implemented",
  "code_reviews_requested",
  "code_reviews_saved",
  "applying_reviews",
  "completed",
  "error",
]);
export type WorkflowImplementationStatus = typeof WorkflowImplementationStatus.Type;

export const WorkflowModelSlot = Schema.Struct({
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  modelOptions: Schema.optional(ProviderModelOptions),
});
export type WorkflowModelSlot = typeof WorkflowModelSlot.Type;

export const WorkflowReview = Schema.Struct({
  slot: WorkflowReviewSlot,
  threadId: ThreadId,
  outputFilePath: Schema.NullOr(TrimmedNonEmptyString),
  status: WorkflowStepStatus,
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type WorkflowReview = typeof WorkflowReview.Type;

export const WorkflowCodeReview = Schema.Struct({
  reviewerLabel: TrimmedNonEmptyString,
  reviewerSlot: WorkflowModelSlot,
  threadId: ThreadId,
  status: WorkflowStepStatus,
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  lastRetryAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  updatedAt: IsoDateTime,
});
export type WorkflowCodeReview = typeof WorkflowCodeReview.Type;

export const WorkflowBranch = Schema.Struct({
  branchId: WorkflowBranchId,
  authorSlot: WorkflowModelSlot,
  authorThreadId: ThreadId,
  planFilePath: Schema.NullOr(TrimmedNonEmptyString),
  planTurnId: Schema.NullOr(TrimmedNonEmptyString),
  revisionTurnId: Schema.NullOr(TrimmedNonEmptyString),
  reviews: Schema.Array(WorkflowReview),
  status: WorkflowBranchStatus,
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  lastRetryAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  updatedAt: IsoDateTime,
});
export type WorkflowBranch = typeof WorkflowBranch.Type;

export const WorkflowMerge = Schema.Struct({
  mergeSlot: WorkflowModelSlot,
  threadId: Schema.NullOr(ThreadId),
  outputFilePath: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  approvedPlanId: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => null)),
  status: WorkflowMergeStatus,
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type WorkflowMerge = typeof WorkflowMerge.Type;

export const WorkflowImplementation = Schema.Struct({
  implementationSlot: WorkflowModelSlot,
  threadId: Schema.NullOr(ThreadId),
  implementationTurnId: Schema.NullOr(TrimmedNonEmptyString),
  revisionTurnId: Schema.NullOr(TrimmedNonEmptyString),
  codeReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  codeReviews: Schema.Array(WorkflowCodeReview),
  status: WorkflowImplementationStatus,
  error: Schema.NullOr(Schema.String),
  retryCount: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  lastRetryAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  updatedAt: IsoDateTime,
});
export type WorkflowImplementation = typeof WorkflowImplementation.Type;

export const PlanningWorkflow = Schema.Struct({
  id: PlanningWorkflowId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  requirementPrompt: TrimmedNonEmptyString,
  plansDirectory: TrimmedNonEmptyString,
  selfReviewEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  branchA: WorkflowBranch,
  branchB: WorkflowBranch,
  merge: WorkflowMerge,
  implementation: Schema.NullOr(WorkflowImplementation).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  totalCostUsd: Schema.Number.pipe(Schema.withDecodingDefault(() => 0)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type PlanningWorkflow = typeof PlanningWorkflow.Type;
