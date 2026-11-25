import { type InvestigationWorkflowSummary as InvestigationWorkflow } from "@t3tools/contracts";
import { deriveInvestigationWorkflowStatus } from "@t3tools/shared/workflowStatus";
import {
  investigationCrossReviews,
  investigationInvestigators,
} from "@t3tools/shared/workflowParticipants";

export function statusLabel(workflow: InvestigationWorkflow): string {
  switch (deriveInvestigationWorkflowStatus(workflow)) {
    case "investigating":
      return "Investigating";
    case "investigations_complete":
      return "Investigations complete";
    case "cross_reviewing":
      return "Cross-reviewing";
    case "cross_reviews_complete":
      return "Cross-reviews complete";
    case "self_reviewing":
      return "Own-model reviewing";
    case "self_reviews_complete":
      return "Reviews complete";
    case "pending_synthesis":
      return "Pending synthesis";
    case "synthesizing":
      return "Synthesizing RCA";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Pending";
  }
}

function investigatorsOf(workflow: InvestigationWorkflow) {
  return investigationInvestigators(workflow).map(({ investigator }) => investigator);
}

function allInvestigationsCompleted(workflow: InvestigationWorkflow): boolean {
  return investigatorsOf(workflow).every(
    (investigator) => investigator.investigationStatus === "completed",
  );
}

function allCrossReviewsCompleted(workflow: InvestigationWorkflow): boolean {
  return investigationCrossReviews(workflow).every((view) => view.status === "completed");
}

export function canRetryFailedInvestigationPhase(workflow: InvestigationWorkflow): boolean {
  return (
    investigatorsOf(workflow).some(
      (investigator) =>
        investigator.investigationStatus === "error" || investigator.selfReviewStatus === "error",
    ) ||
    investigationCrossReviews(workflow).some((view) => view.status === "error") ||
    workflow.synthesis.status === "error"
  );
}

export function canRetryCrossReview(workflow: InvestigationWorkflow): boolean {
  return (
    allInvestigationsCompleted(workflow) &&
    investigationCrossReviews(workflow).some(
      (view) => view.status === "error" || view.status === "completed",
    )
  );
}

export function canRetrySelfReview(workflow: InvestigationWorkflow): boolean {
  return (
    workflow.selfReviewEnabled &&
    allInvestigationsCompleted(workflow) &&
    investigatorsOf(workflow).some(
      (investigator) =>
        investigator.selfReviewStatus === "error" || investigator.selfReviewStatus === "completed",
    )
  );
}

export function canRetrySynthesis(workflow: InvestigationWorkflow): boolean {
  return (
    allCrossReviewsCompleted(workflow) &&
    (!workflow.selfReviewEnabled ||
      investigatorsOf(workflow).every(
        (investigator) => investigator.selfReviewStatus === "completed",
      )) &&
    (workflow.synthesis.status === "error" || workflow.synthesis.status === "completed")
  );
}
