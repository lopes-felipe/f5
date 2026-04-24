import { deriveCodeReviewWorkflowStatus, type CodeReviewWorkflow } from "@t3tools/contracts";

export function statusLabel(workflow: CodeReviewWorkflow): string {
  switch (deriveCodeReviewWorkflowStatus(workflow)) {
    case "reviewing":
      return "Reviewing";
    case "reviews_complete":
      return "Reviews complete";
    case "pending_consolidation":
      return "Pending merge";
    case "consolidating":
      return "Merging reviews";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Pending";
  }
}

export function canRetryFailedReviewers(workflow: CodeReviewWorkflow): boolean {
  return workflow.reviewerA.status === "error" || workflow.reviewerB.status === "error";
}

export function canRetryConsolidation(workflow: CodeReviewWorkflow): boolean {
  return (
    workflow.reviewerA.status === "completed" &&
    workflow.reviewerB.status === "completed" &&
    workflow.consolidation.status === "error"
  );
}
