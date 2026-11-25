import { isDocumentWorkflow, documentReaderPassPhase } from "@t3tools/shared/documentWorkflow";
import type { PlanningWorkflowSummary as PlanningWorkflow } from "@t3tools/contracts";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import {
  planningBranches,
  planReviewReviewerBranchId,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";

export type PlanningWorkflowErrorDetail = {
  readonly key: string;
  readonly step: string;
  readonly message: string;
};

export function collectPlanningWorkflowErrors(
  workflow: PlanningWorkflow,
): PlanningWorkflowErrorDetail[] {
  const errors: PlanningWorkflowErrorDetail[] = [];
  if (workflow.readerPass?.status === "error")
    errors.push({
      key: "reader-pass",
      step: workflow.readerPass.errorStage === "polish" ? "Polish" : "Reader review",
      message: workflow.readerPass.error ?? "Reader pass failed.",
    });

  const mesh = workflowUsesMesh(planningBranches(workflow).length);
  for (const branch of planningBranches(workflow)) {
    const branchLabel = workflowParticipantLabel(branch.branchId);
    const stage = planningWorkflowBranchFailureStage(branch);
    if (stage && stage !== "reviews" && branch.error) {
      errors.push({
        key: `${stage}-${branchLabel}`,
        step: `${stage === "authoring" ? "Authoring" : "Revision"} · Branch ${branchLabel}`,
        message: branch.error,
      });
    }
    const reviewErrors = branch.reviews.filter((review) => review.status === "error");
    for (const review of reviewErrors) {
      errors.push({
        key: `review-${branchLabel}-${review.slot}-${review.threadId}`,
        step:
          mesh && review.slot === "cross"
            ? `Reviews · Review ${branchLabel} by ${workflowParticipantLabel(
                planReviewReviewerBranchId(workflow, branch.branchId, review),
              )}`
            : `Reviews · Review ${branchLabel} ${review.slot === "cross" ? "Cross" : "Self"}`,
        message: review.error ?? "Review failed.",
      });
    }
    if (stage === "reviews" && reviewErrors.length === 0 && branch.error) {
      errors.push({
        key: `reviews-${branchLabel}`,
        step: `Reviews · Branch ${branchLabel}`,
        message: branch.error,
      });
    }
  }

  if (workflow.merge.status === "error") {
    errors.push({
      key: "merge",
      step: "Merge",
      message: workflow.merge.error ?? "Merge failed.",
    });
  }

  if (workflow.implementation?.status === "error") {
    const failedCodeReviews = workflow.implementation.codeReviews.filter(
      (review) => review.status === "error",
    );
    if (failedCodeReviews.length > 0) {
      for (const review of failedCodeReviews) {
        errors.push({
          key: `code-review-${review.threadId}`,
          step: `Code Review · ${review.reviewerLabel}`,
          message: review.error ?? "Code review failed.",
        });
      }
    } else {
      const applyingReviews =
        workflow.implementation.codeReviews.length > 0 &&
        workflow.implementation.codeReviews.every((review) => review.status === "completed");
      errors.push({
        key: applyingReviews ? "apply-reviews" : "implementation",
        step: applyingReviews ? "Apply Reviews" : "Implementation",
        message: workflow.implementation.error ?? "Implementation failed.",
      });
    }
  }

  return errors;
}

export function canRetryFailedPlanningWorkflow(workflow: PlanningWorkflow): boolean {
  return collectPlanningWorkflowErrors(workflow).length > 0;
}

export function planningWorkflowStatusLabel(workflow: PlanningWorkflow): string {
  if (canRetryFailedPlanningWorkflow(workflow)) {
    return "Error";
  }
  if (isDocumentWorkflow(workflow)) {
    if (workflow.merge.status === "manual_review") return "Document ready";
    const phase = documentReaderPassPhase(workflow);
    if (phase === "reading") return "Reader reviewing";
    if (phase === "polishing") return "Polishing";
  }
  if (workflow.implementation) {
    switch (workflow.implementation.status) {
      case "implementing":
        return "Implementing";
      case "implemented":
        return "Implementation done";
      case "code_reviews_requested":
        return "Code reviewing";
      case "code_reviews_saved":
      case "applying_reviews":
        return "Applying review feedback";
      case "completed":
        return "Completed";
      default:
        break;
    }
  }
  if (workflow.merge.status === "merged") return "Merged";
  if (workflow.merge.status === "manual_review") return "Manual review";
  if (workflow.merge.status === "in_progress") return "Merging";
  const branches = planningBranches(workflow);
  if (branches.every((branch) => branch.status === "revised")) {
    return "Ready to merge";
  }
  if (branches.some((branch) => branch.status === "revising")) {
    return "Revising";
  }
  if (branches.some((branch) => branch.status === "reviews_saved")) {
    return "Revising";
  }
  if (branches.some((branch) => branch.status === "reviews_requested")) {
    return "Reviewing";
  }
  if (branches.every((branch) => branch.planTurnId)) {
    return isDocumentWorkflow(workflow) ? "Drafts ready" : "Plans drafted";
  }
  return "Authoring";
}
