import type { PlanningWorkflow } from "@t3tools/contracts";

export type PlanningWorkflowBranchFailureStage = "authoring" | "reviews" | "revision";

/**
 * Infers the owner of a legacy branch-level error. New records persist
 * authoring/revision failures on errorStage and review failures on reviews.
 */
export function planningWorkflowBranchFailureStage(
  branch: PlanningWorkflow["branchA"],
): PlanningWorkflowBranchFailureStage | null {
  if (branch.status !== "error") {
    return null;
  }
  if (branch.errorStage) {
    return branch.errorStage;
  }
  if (!branch.planTurnId) {
    return "authoring";
  }
  return branch.reviews.length > 0 &&
    branch.reviews.every((review) => review.status === "completed")
    ? "revision"
    : "reviews";
}
