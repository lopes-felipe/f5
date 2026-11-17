import { expect, it } from "vitest";
import type { PrAttentionState, TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";

import { isPrStalled, waitingLabel } from "./prHubPresentation";

function makePr(
  overrides: Partial<TrackedPullRequest> & { attentionState: PrAttentionState },
): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#1"),
    provider: "github",
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
    viewerReviewRequested:
      overrides.attentionState === "review_requested" ||
      overrides.attentionState === "re_review_requested",
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
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

it("derives staleness locally and supports disabling it", () => {
  const pr = makePr({
    attentionState: "awaiting_review",
    roles: ["author"],
    waitingSince: "2026-01-01T00:00:00Z",
  });
  const now = Date.parse("2026-01-02T00:00:00Z");
  expect(isPrStalled(pr, 24, now)).toBe(true);
  expect(isPrStalled(pr, 0, now)).toBe(false);
  expect(isPrStalled(pr, 25, now)).toBe(false);
  expect(waitingLabel(pr, now)).toContain("1d ago");
  expect(waitingLabel(pr, now - 23.5 * 3_600_000)).toBeNull();
});
