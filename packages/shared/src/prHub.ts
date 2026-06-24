import type {
  PrAttentionBucket,
  PrAttentionState,
  PrCheckRollup,
  PrMergeable,
  PrReviewDecision,
  PrViewerRole,
} from "@t3tools/contracts";

export interface RawPrFields {
  readonly author?: string | null | undefined;
  readonly isAuthor?: boolean | undefined;
  readonly isDraft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly checkRollup: PrCheckRollup;
  readonly mergeable: PrMergeable;
  readonly mergeStateStatus: string;
  readonly reviewDecision: PrReviewDecision;
  readonly viewerHasReviewed: boolean;
  readonly viewerReviewRequested: boolean;
  readonly roles: ReadonlyArray<PrViewerRole>;
}

export interface PrAttentionDerivation {
  readonly attentionState: PrAttentionState;
  readonly attentionBucket: PrAttentionBucket;
  readonly primaryReason: string;
  readonly nextAction: string;
}

export const PR_HUB_NEEDS_YOU_STATES: ReadonlySet<PrAttentionState> = new Set([
  "ci_failing",
  "merge_conflict",
  "branch_behind",
  "changes_requested",
  "ready_to_merge",
  "review_requested",
  "re_review_requested",
]);

function isFailureRollup(checkRollup: PrCheckRollup): boolean {
  return checkRollup === "failure" || checkRollup === "error";
}

function isPassingOrNoChecks(checkRollup: PrCheckRollup): boolean {
  return checkRollup === "success" || checkRollup === "none";
}

function isDirtyMergeState(mergeStateStatus: string): boolean {
  return mergeStateStatus.trim().toUpperCase() === "DIRTY";
}

function isBehindMergeState(mergeStateStatus: string): boolean {
  return mergeStateStatus.trim().toUpperCase() === "BEHIND";
}

function result(
  attentionState: PrAttentionState,
  attentionBucket: PrAttentionBucket,
  primaryReason: string,
  nextAction: string,
): PrAttentionDerivation {
  return { attentionState, attentionBucket, primaryReason, nextAction };
}

export function derivePrAttention(input: RawPrFields): PrAttentionDerivation {
  const isAuthor = input.isAuthor === true || input.roles.includes("author");

  if (input.state === "merged") {
    return result("merged", "informational", "Merged", "Merged");
  }

  if (input.state === "closed") {
    return result("closed", "informational", "Closed without merge", "Closed without merge");
  }

  if (isAuthor && input.isDraft) {
    return result("draft", "informational", "Draft", "Draft - finish and mark ready");
  }

  if (isAuthor && isFailureRollup(input.checkRollup)) {
    return result("ci_failing", "needs_you", "CI failing", "Fix failing CI");
  }

  if (
    isAuthor &&
    (input.mergeable === "conflicting" || isDirtyMergeState(input.mergeStateStatus))
  ) {
    return result("merge_conflict", "needs_you", "Merge conflicts", "Resolve merge conflicts");
  }

  if (isAuthor && isBehindMergeState(input.mergeStateStatus)) {
    return result("branch_behind", "needs_you", "Branch behind", "Update branch");
  }

  if (isAuthor && input.reviewDecision === "changes_requested") {
    return result(
      "changes_requested",
      "needs_you",
      "Changes requested",
      "Address requested changes",
    );
  }

  if (
    isAuthor &&
    input.reviewDecision === "approved" &&
    isPassingOrNoChecks(input.checkRollup) &&
    input.mergeable === "mergeable"
  ) {
    return result("ready_to_merge", "needs_you", "Ready to merge", "Ready to merge");
  }

  if (isAuthor) {
    return result(
      "awaiting_review",
      "waiting_on_others",
      "Awaiting review",
      "Waiting on reviewers",
    );
  }

  if (input.viewerReviewRequested && !input.viewerHasReviewed) {
    return result("review_requested", "needs_you", "Review requested", "Review requested");
  }

  if (input.viewerReviewRequested && input.viewerHasReviewed) {
    return result("re_review_requested", "needs_you", "Re-review requested", "Re-review requested");
  }

  if (input.viewerHasReviewed) {
    return result(
      "reviewed_waiting",
      "waiting_on_others",
      "You reviewed",
      "You reviewed - waiting on author",
    );
  }

  return result("mentioned", "informational", "You're involved", "You're involved");
}
