import { deriveInvestigationWorkflowStatus, type InvestigationWorkflow } from "@t3tools/contracts";

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

export function canRetryFailedInvestigationPhase(workflow: InvestigationWorkflow): boolean {
  return (
    workflow.investigatorA.investigationStatus === "error" ||
    workflow.investigatorB.investigationStatus === "error" ||
    workflow.investigatorA.crossReviewStatus === "error" ||
    workflow.investigatorB.crossReviewStatus === "error" ||
    workflow.investigatorA.selfReviewStatus === "error" ||
    workflow.investigatorB.selfReviewStatus === "error" ||
    workflow.synthesis.status === "error"
  );
}

export function canRetryCrossReview(workflow: InvestigationWorkflow): boolean {
  return (
    workflow.investigatorA.investigationStatus === "completed" &&
    workflow.investigatorB.investigationStatus === "completed" &&
    (workflow.investigatorA.crossReviewStatus === "error" ||
      workflow.investigatorB.crossReviewStatus === "error" ||
      workflow.investigatorA.crossReviewStatus === "completed" ||
      workflow.investigatorB.crossReviewStatus === "completed")
  );
}

export function canRetrySelfReview(workflow: InvestigationWorkflow): boolean {
  return (
    workflow.selfReviewEnabled &&
    workflow.investigatorA.investigationStatus === "completed" &&
    workflow.investigatorB.investigationStatus === "completed" &&
    (workflow.investigatorA.selfReviewStatus === "error" ||
      workflow.investigatorB.selfReviewStatus === "error" ||
      workflow.investigatorA.selfReviewStatus === "completed" ||
      workflow.investigatorB.selfReviewStatus === "completed")
  );
}

export function canRetrySynthesis(workflow: InvestigationWorkflow): boolean {
  return (
    workflow.investigatorA.crossReviewStatus === "completed" &&
    workflow.investigatorB.crossReviewStatus === "completed" &&
    (!workflow.selfReviewEnabled ||
      (workflow.investigatorA.selfReviewStatus === "completed" &&
        workflow.investigatorB.selfReviewStatus === "completed")) &&
    (workflow.synthesis.status === "error" || workflow.synthesis.status === "completed")
  );
}
