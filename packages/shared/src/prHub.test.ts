import { describe, expect, it } from "vitest";

import { derivePrAttention, PR_HUB_NEEDS_YOU_STATES, type RawPrFields } from "./prHub";

const basePr: RawPrFields = {
  author: "octocat",
  isAuthor: false,
  isDraft: false,
  state: "open",
  checkRollup: "success",
  mergeable: "mergeable",
  mergeStateStatus: "CLEAN",
  reviewDecision: "none",
  viewerHasReviewed: false,
  viewerReviewRequested: false,
  roles: ["involved"],
};

function derive(overrides: Partial<RawPrFields>) {
  return derivePrAttention({ ...basePr, ...overrides });
}

describe("derivePrAttention", () => {
  it.each([
    [{ state: "merged" as const }, "merged", "informational", "Merged"],
    [{ state: "closed" as const }, "closed", "informational", "Closed without merge"],
    [{ isAuthor: true, isDraft: true }, "draft", "informational", "Draft - finish and mark ready"],
    [
      { isAuthor: true, checkRollup: "failure" as const },
      "ci_failing",
      "needs_you",
      "Fix failing CI",
    ],
    [
      { isAuthor: true, checkRollup: "error" as const },
      "ci_failing",
      "needs_you",
      "Fix failing CI",
    ],
    [
      { isAuthor: true, mergeable: "conflicting" as const },
      "merge_conflict",
      "needs_you",
      "Resolve merge conflicts",
    ],
    [
      { isAuthor: true, mergeStateStatus: "DIRTY" },
      "merge_conflict",
      "needs_you",
      "Resolve merge conflicts",
    ],
    [{ isAuthor: true, mergeStateStatus: "BEHIND" }, "branch_behind", "needs_you", "Update branch"],
    [
      { isAuthor: true, reviewDecision: "changes_requested" as const },
      "changes_requested",
      "needs_you",
      "Address requested changes",
    ],
    [
      { isAuthor: true, reviewDecision: "approved" as const },
      "ready_to_merge",
      "needs_you",
      "Ready to merge",
    ],
    [{ isAuthor: true }, "awaiting_review", "waiting_on_others", "Waiting on reviewers"],
    [
      { viewerReviewRequested: true, viewerHasReviewed: false },
      "review_requested",
      "needs_you",
      "Review requested",
    ],
    [
      { viewerReviewRequested: true, viewerHasReviewed: true },
      "re_review_requested",
      "needs_you",
      "Re-review requested",
    ],
    [
      { viewerHasReviewed: true },
      "reviewed_waiting",
      "waiting_on_others",
      "You reviewed - waiting on author",
    ],
    [{ roles: ["mentioned"] as const }, "mentioned", "informational", "You're involved"],
  ])("derives %#", (overrides, attentionState, attentionBucket, nextAction) => {
    expect(derive(overrides)).toMatchObject({
      attentionState,
      attentionBucket,
      nextAction,
    });
  });

  it("does not mark approved author PRs ready when mergeability is unknown", () => {
    expect(
      derive({
        isAuthor: true,
        reviewDecision: "approved",
        mergeable: "unknown",
        mergeStateStatus: "UNKNOWN",
      }),
    ).toMatchObject({
      attentionState: "awaiting_review",
      attentionBucket: "waiting_on_others",
    });
  });

  it("treats UNKNOWN merge state as neutral", () => {
    expect(
      derive({
        isAuthor: true,
        reviewDecision: "none",
        mergeable: "mergeable",
        mergeStateStatus: "UNKNOWN",
      }),
    ).toMatchObject({
      attentionState: "awaiting_review",
      attentionBucket: "waiting_on_others",
    });
  });

  it("treats the author role as author even without isAuthor", () => {
    expect(
      derive({
        isAuthor: false,
        roles: ["author", "mentioned"],
        reviewDecision: "changes_requested",
      }),
    ).toMatchObject({
      attentionState: "changes_requested",
      attentionBucket: "needs_you",
    });
  });

  it("tracks every needs-you state in the exported set", () => {
    expect(PR_HUB_NEEDS_YOU_STATES).toEqual(
      new Set([
        "ci_failing",
        "merge_conflict",
        "branch_behind",
        "changes_requested",
        "ready_to_merge",
        "review_requested",
        "re_review_requested",
      ]),
    );
  });
});
