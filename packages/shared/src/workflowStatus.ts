import type {
  CodeReviewReviewer,
  CodeReviewWorkflow,
  InvestigationWorkflow,
} from "@t3tools/contracts";

import {
  codeReviewReviewers,
  investigationCrossReviews,
  investigationInvestigators,
  type CodeReviewRoster,
  type InvestigationRoster,
  type InvestigatorCrossReviewFields,
} from "./workflowParticipants";

export type DerivedCodeReviewWorkflowStatus =
  | "pending"
  | "reviewing"
  | "reviews_complete"
  | "pending_consolidation"
  | "consolidating"
  | "completed"
  | "error";

export function deriveCodeReviewWorkflowStatus(
  workflow: CodeReviewRoster<Pick<CodeReviewReviewer, "status">> &
    Pick<CodeReviewWorkflow, "consolidation">,
): DerivedCodeReviewWorkflowStatus {
  const reviewers = codeReviewReviewers(workflow).map((entry) => entry.reviewer);
  if (
    reviewers.some((reviewer) => reviewer.status === "error") ||
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
  if (reviewers.every((reviewer) => reviewer.status === "completed")) {
    return "reviews_complete";
  }
  if (reviewers.some((reviewer) => reviewer.status === "running")) {
    return "reviewing";
  }
  return "pending";
}

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
  workflow: InvestigationRoster<InvestigatorCrossReviewFields> &
    Pick<InvestigationWorkflow, "selfReviewEnabled" | "synthesis">,
): DerivedInvestigationWorkflowStatus {
  const investigators = investigationInvestigators(workflow).map((entry) => entry.investigator);
  const crossReviews = investigationCrossReviews(workflow);
  if (
    investigators.some(
      (investigator) =>
        investigator.investigationStatus === "error" || investigator.selfReviewStatus === "error",
    ) ||
    crossReviews.some((review) => review.status === "error") ||
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
    crossReviews.length > 0 && crossReviews.every((review) => review.status === "completed");
  const selfReviewsComplete = investigators.every(
    (investigator) => investigator.selfReviewStatus === "completed",
  );
  if (crossReviewsComplete && workflow.selfReviewEnabled && selfReviewsComplete) {
    return "self_reviews_complete";
  }
  if (
    crossReviews.some((review) => review.status === "pending_start" || review.status === "running")
  ) {
    return "cross_reviewing";
  }
  if (
    workflow.selfReviewEnabled &&
    (investigators.some(
      (investigator) =>
        investigator.selfReviewStatus === "pending_start" ||
        investigator.selfReviewStatus === "running",
    ) ||
      crossReviewsComplete)
  ) {
    return "self_reviewing";
  }
  if (crossReviewsComplete) {
    return "cross_reviews_complete";
  }
  if (investigators.every((investigator) => investigator.investigationStatus === "completed")) {
    return "investigations_complete";
  }
  if (investigators.some((investigator) => investigator.investigationStatus === "running")) {
    return "investigating";
  }
  return "pending";
}
