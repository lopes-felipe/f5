import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { PrHubDetailResult, PrHubSnapshot, TrackedPullRequest } from "./prHub";
import { SourceControlPullRequestRef } from "./sourceControl";

const legacyTrackedPullRequest = {
  key: "github.com/octo/repo#7",
  nodeId: "PR_7",
  number: 7,
  title: "Neutralize source control",
  url: "https://github.com/octo/repo/pull/7",
  repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
  host: "github.com",
  author: "octo",
  isDraft: false,
  state: "open",
  roles: ["author"],
  attentionState: "awaiting_review",
  attentionBucket: "waiting_on_others",
  primaryReason: "Waiting for review",
  nextAction: "Wait for reviewers",
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
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  headRefOid: "abc123",
  baseRefName: "main",
  headRefName: "feature/source-control",
  labels: [],
  assignees: [],
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T11:00:00.000Z",
  snoozedUntil: null,
  ignoredAt: null,
  notificationPending: false,
  attentionFingerprint: "fingerprint",
};

describe("source-control contracts", () => {
  it("decodes provider-qualified pull-request references", () => {
    expect(
      Schema.decodeUnknownSync(SourceControlPullRequestRef)({
        provider: "github",
        host: "github.com",
        repository: "octo/repo",
        number: 7,
      }),
    ).toEqual({
      provider: "github",
      host: "github.com",
      repository: "octo/repo",
      number: 7,
    });
  });

  it("decodes legacy tracked PRs and snapshots with GitHub defaults", () => {
    const pr = Schema.decodeUnknownSync(TrackedPullRequest)(legacyTrackedPullRequest);
    expect(pr.provider).toBe("github");
    expect(pr.ref).toBeUndefined();

    const snapshot = Schema.decodeUnknownSync(PrHubSnapshot)({
      status: "ok",
      viewerLogin: "octo",
      host: "github.com",
      pullRequests: [legacyTrackedPullRequest],
      recentlyResolved: [],
      lastPolledAt: null,
    });
    expect(snapshot.pullRequests[0]?.provider).toBe("github");
    expect(snapshot.authStates).toBeUndefined();
  });

  it("keeps provider-native detail fields inside the GitHub variant", () => {
    const result = Schema.decodeUnknownSync(PrHubDetailResult)({
      detail: {
        key: "github:github.com/octo/repo#7",
        providerDetails: {
          provider: "github",
          nodeId: "PR_7",
          mergeStateStatus: "CLEAN",
          headRefOid: "head",
          baseRefOid: "base",
          viewerCanUpdate: true,
          viewerDidAuthor: true,
        },
        title: "Detail",
        body: "Body",
        url: "https://github.com/octo/repo/pull/7",
        state: "open",
        isDraft: false,
        mergeable: "mergeable",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        headRefName: "feature",
        baseRefName: "main",
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T11:00:00.000Z",
        mergedAt: null,
        closedAt: null,
        author: null,
        labels: [],
        reviewers: [],
        checks: [],
        reactions: [],
      },
      stale: false,
      refreshedAt: "2026-08-15T11:00:00.000Z",
    });

    expect(result.detail.providerDetails.provider).toBe("github");
    if (result.detail.providerDetails.provider === "github") {
      expect(result.detail.providerDetails.nodeId).toBe("PR_7");
    }
  });
});
