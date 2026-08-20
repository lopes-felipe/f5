import { deriveCodeReviewWorkflowStatus, type CodeReviewWorkflow } from "@t3tools/contracts";

export interface CodeReviewWorkflowError {
  readonly key: "reviewerA" | "reviewerB" | "consolidation";
  readonly step: string;
  readonly message: string;
}

export function collectCodeReviewWorkflowErrors(
  workflow: CodeReviewWorkflow,
): readonly CodeReviewWorkflowError[] {
  const errors: CodeReviewWorkflowError[] = [];
  if (workflow.reviewerA.status === "error") {
    errors.push({
      key: "reviewerA",
      step: workflow.reviewerA.label,
      message: workflow.reviewerA.error ?? "Reviewer failed.",
    });
  }
  if (workflow.reviewerB.status === "error") {
    errors.push({
      key: "reviewerB",
      step: workflow.reviewerB.label,
      message: workflow.reviewerB.error ?? "Reviewer failed.",
    });
  }
  if (workflow.consolidation.status === "error") {
    errors.push({
      key: "consolidation",
      step: "Merge",
      message: workflow.consolidation.error ?? "Review merge failed.",
    });
  }
  return errors;
}

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
