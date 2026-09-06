import { describe, expect, it } from "vitest";
import { PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";

import { prDetailCapability, setViewerReaction } from "./prDetails.logic";

function makePr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#1"),
    provider: "github",
    nodeId: "PR_1",
    number: 1,
    title: "PR",
    url: "https://github.com/octo/repo/pull/1",
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "awaiting_review",
    attentionBucket: "waiting_on_others",
    primaryReason: "Waiting",
    nextAction: "Wait",
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
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headRefOid: "head",
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint",
    ...overrides,
  };
}

describe("PR detail logic", () => {
  it("fails closed when provider capability data is absent", () => {
    expect(prDetailCapability(makePr(), "react")).toEqual({
      supported: false,
      reason: "This action is unavailable until provider capabilities are refreshed.",
    });
  });

  it("preserves provider reasons for unsupported actions", () => {
    expect(
      prDetailCapability(
        makePr({ capabilities: [{ action: "update-branch", supported: false, reason: "No API" }] }),
        "update-branch",
      ),
    ).toEqual({ supported: false, reason: "No API" });
  });

  it("optimistically adds and rolls back viewer reaction counts", () => {
    const added = setViewerReaction([], "eyes", true);
    expect(added).toEqual([{ content: "eyes", count: 1, viewerHasReacted: true, actors: [] }]);
    expect(setViewerReaction(added, "eyes", false)).toEqual([]);
  });
});
