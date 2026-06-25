import { describe, expect, it } from "vitest";
import type { PrAttentionState, TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";

import { comparePrPriority, prRowActionVisibility, primaryActionFor } from "./prHubPresentation";

function makePr(
  overrides: Partial<TrackedPullRequest> & { attentionState: PrAttentionState },
): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github.com/octo/repo#1"),
    nodeId: "PR_1",
    number: 1,
    title: "Test",
    url: "https://github.com/octo/repo/pull/1",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "someone",
    isDraft: false,
    state: "open",
    roles: [],
    attentionBucket: "needs_you",
    primaryReason: "",
    nextAction: "",
    checkRollup: "success",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: null,
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

const reviewer = { isAuthor: false, isOpen: true, isIgnored: false };
const author = { isAuthor: true, isOpen: true, isIgnored: false };

describe("primaryActionFor", () => {
  it("offers Approve to a requested reviewer", () => {
    expect(primaryActionFor(makePr({ attentionState: "review_requested" }), reviewer)?.kind).toBe(
      "approve",
    );
    expect(
      primaryActionFor(makePr({ attentionState: "re_review_requested" }), reviewer)?.kind,
    ).toBe("approve");
  });

  it("offers Merge to the author when ready to merge", () => {
    expect(primaryActionFor(makePr({ attentionState: "ready_to_merge" }), author)?.kind).toBe(
      "merge",
    );
  });

  it("offers Ready to the author of a draft", () => {
    expect(primaryActionFor(makePr({ attentionState: "draft" }), author)?.kind).toBe("markReady");
  });

  it("offers Re-request only when awaiting review with reviewers", () => {
    expect(
      primaryActionFor(
        makePr({ attentionState: "awaiting_review", reviewRequestReviewers: ["alice"] }),
        author,
      )?.kind,
    ).toBe("reRequest");
    expect(
      primaryActionFor(
        makePr({ attentionState: "awaiting_review", reviewRequestReviewers: [] }),
        author,
      ),
    ).toBeNull();
  });

  it("does not let an author review their own PR", () => {
    expect(primaryActionFor(makePr({ attentionState: "review_requested" }), author)).toBeNull();
  });

  it("returns null for non-actionable states", () => {
    expect(primaryActionFor(makePr({ attentionState: "ci_failing" }), author)).toBeNull();
    expect(primaryActionFor(makePr({ attentionState: "mentioned" }), reviewer)).toBeNull();
  });

  it("returns null when the PR is closed or ignored", () => {
    const pr = makePr({ attentionState: "review_requested" });
    expect(primaryActionFor(pr, { ...reviewer, isOpen: false })).toBeNull();
    expect(primaryActionFor(pr, { ...reviewer, isIgnored: true })).toBeNull();
  });
});

describe("prRowActionVisibility", () => {
  it("exposes review actions only to a requested reviewer", () => {
    expect(
      prRowActionVisibility(makePr({ attentionState: "review_requested" }), reviewer).canReview,
    ).toBe(true);
    expect(
      prRowActionVisibility(makePr({ attentionState: "review_requested" }), author).canReview,
    ).toBe(false);
  });

  it("disables every action for a closed or ignored PR", () => {
    const pr = makePr({ attentionState: "review_requested" });
    const closed = prRowActionVisibility(pr, { ...reviewer, isOpen: false });
    expect(closed.primary).toBeNull();
    expect(closed.canReview).toBe(false);
    expect(closed.canSnooze).toBe(false);
    expect(closed.canSuggest).toBe(false);
    expect(closed.canIgnore).toBe(false);

    const ignored = prRowActionVisibility(pr, { ...reviewer, isIgnored: true });
    expect(ignored.canSnooze).toBe(false);
    expect(ignored.canIgnore).toBe(false);
  });

  it("allows snooze/suggest/ignore on any open, non-ignored PR", () => {
    const visibility = prRowActionVisibility(makePr({ attentionState: "ci_failing" }), author);
    expect(visibility.canSnooze).toBe(true);
    expect(visibility.canSuggest).toBe(true);
    expect(visibility.canIgnore).toBe(true);
  });
});

describe("comparePrPriority", () => {
  const order = (prs: TrackedPullRequest[]) =>
    [...prs].sort(comparePrPriority).map((pr) => pr.number);

  it("orders needs_you before waiting_on_others before informational", () => {
    const fyi = makePr({
      number: 1,
      attentionState: "mentioned",
      attentionBucket: "informational",
    });
    const waiting = makePr({
      number: 2,
      attentionState: "reviewed_waiting",
      attentionBucket: "waiting_on_others",
    });
    const needsYou = makePr({
      number: 3,
      attentionState: "ci_failing",
      attentionBucket: "needs_you",
    });

    expect(order([fyi, waiting, needsYou])).toEqual([3, 2, 1]);
  });

  it("orders by attention-state severity within a bucket", () => {
    const draft = makePr({ number: 1, attentionState: "draft" });
    const ci = makePr({ number: 2, attentionState: "ci_failing" });
    const conflict = makePr({ number: 3, attentionState: "merge_conflict" });

    expect(order([draft, ci, conflict])).toEqual([3, 2, 1]);
  });

  it("breaks ties by most-recently-updated first", () => {
    const older = makePr({
      number: 1,
      attentionState: "ci_failing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = makePr({
      number: 2,
      attentionState: "ci_failing",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(order([older, newer])).toEqual([2, 1]);
  });
});
