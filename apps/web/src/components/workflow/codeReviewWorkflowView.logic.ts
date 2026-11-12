import {
  deriveCodeReviewWorkflowStatus,
  type CodeReviewWorkflowSummary as CodeReviewWorkflow,
} from "@t3tools/contracts";
import { isGitHubCodeReviewPullRequest } from "@t3tools/shared/codeReviewPullRequest";

export interface CodeReviewWorkflowError {
  readonly key: "reviewerA" | "reviewerB" | "consolidation" | "post";
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
  const post = workflow.post;
  if (post && (post.status === "failed" || post.status === "needs_recovery")) {
    errors.push({
      key: "post",
      step: post.status === "failed" ? "Post to PR" : "Post to PR (outcome unknown)",
      message: post.error ?? "Posting the merged review failed.",
    });
  }
  return errors;
}

export type CodeReviewPostAction =
  | { readonly kind: "post"; readonly label: "Post to PR" }
  | { readonly kind: "posting"; readonly label: "Posting…" }
  | { readonly kind: "posted"; readonly label: "Posted"; readonly commentUrl: string | null }
  | {
      readonly kind: "post-again";
      readonly label: "Post again";
      readonly commentUrl: string | null;
    }
  | { readonly kind: "retry"; readonly label: "Retry post" }
  | { readonly kind: "check"; readonly label: "Check again" };

/** The Post to PR action for a finished merged review on a GitHub PR, or null. */
export function codeReviewPostAction(workflow: CodeReviewWorkflow): CodeReviewPostAction | null {
  if (
    workflow.consolidation.status !== "completed" ||
    !isGitHubCodeReviewPullRequest(workflow.pullRequest)
  ) {
    return null;
  }
  const post = workflow.post;
  if (!post) return { kind: "post", label: "Post to PR" };
  switch (post.status) {
    case "posting":
      return { kind: "posting", label: "Posting…" };
    case "posted":
      return post.consolidationTurnId === workflow.consolidation.pinnedTurnId
        ? { kind: "posted", label: "Posted", commentUrl: post.commentUrl }
        : { kind: "post-again", label: "Post again", commentUrl: post.commentUrl };
    case "failed":
      return { kind: "retry", label: "Retry post" };
    case "needs_recovery":
      return { kind: "check", label: "Check again" };
  }
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
      return workflow.post?.status === "failed"
        ? "Completed · post failed"
        : workflow.post?.status === "needs_recovery"
          ? "Completed · post unconfirmed"
          : "Completed";
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
