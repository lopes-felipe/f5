import type { PlanningWorkflow } from "@t3tools/contracts";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";

export type PlanningWorkflowErrorDetail = {
  readonly key: string;
  readonly step: string;
  readonly message: string;
};

export function collectPlanningWorkflowErrors(
  workflow: PlanningWorkflow,
): PlanningWorkflowErrorDetail[] {
  const errors: PlanningWorkflowErrorDetail[] = [];

  for (const [branchLabel, branch] of [
    ["A", workflow.branchA],
    ["B", workflow.branchB],
  ] as const) {
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
        step: `Reviews · Review ${branchLabel} ${review.slot === "cross" ? "Cross" : "Self"}`,
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
  if (workflow.branchA.status === "revised" && workflow.branchB.status === "revised") {
    return "Ready to merge";
  }
  if (workflow.branchA.status === "revising" || workflow.branchB.status === "revising") {
    return "Revising";
  }
  if (workflow.branchA.status === "reviews_saved" || workflow.branchB.status === "reviews_saved") {
    return "Revising";
  }
  if (
    workflow.branchA.status === "reviews_requested" ||
    workflow.branchB.status === "reviews_requested"
  ) {
    return "Reviewing";
  }
  if (workflow.branchA.planTurnId && workflow.branchB.planTurnId) {
    return "Plans drafted";
  }
  return "Authoring";
}
