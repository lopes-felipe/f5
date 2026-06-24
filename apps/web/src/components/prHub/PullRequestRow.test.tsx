import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrHubAdvisory, TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";

import { PullRequestRow } from "./PullRequestRow";

function makePr(): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe("github.com/octo/repo#1"),
    nodeId: "PR_1",
    number: 1,
    title: "Improve advisory flow",
    url: "https://github.com/octo/repo/pull/1",
    repository: {
      owner: "octo",
      repo: "repo",
      nameWithOwner: "octo/repo",
    },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ci_failing",
    attentionBucket: "needs_you",
    primaryReason: "CI failing",
    nextAction: "Fix failing CI",
    checkRollup: "failure",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: ["alice"],
    reviewRequestsCount: 1,
    commentsCount: 2,
    unresolvedThreadCount: 1,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    headRefOid: "head-1",
    baseRefName: "main",
    headRefName: "feature/advisory",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fingerprint-1",
  };
}

function makeAdvisory(pr: TrackedPullRequest): PrHubAdvisory {
  return {
    key: pr.key,
    status: "succeeded",
    recommendation: "fix_ci",
    summary: "Fix failing CI before requesting more review.",
    confidence: 90,
    blockers: ["build"],
    findings: [
      {
        id: "comment-1",
        url: "https://github.com/octo/repo/pull/1#discussion_r1",
        author: "alice",
        category: "review_thread",
        validity: "valid",
        summary: "src/file.ts:10: This must handle null.",
        rationale: "The comment contains concrete blocking or corrective language.",
      },
    ],
    fingerprint: "advisory-fingerprint",
    generatedAt: "2026-01-02T01:00:00.000Z",
    stale: false,
    degraded: false,
    truncated: false,
  };
}

describe("PullRequestRow advisory UI", () => {
  it("renders advisory state and read-only suggest action", () => {
    const pr = makePr();
    const markup = renderToStaticMarkup(
      <PullRequestRow pr={pr} advisory={makeAdvisory(pr)} onAnalyzeAdvisory={() => {}} />,
    );

    expect(markup).toContain("Fix CI");
    expect(markup).toContain("90% confidence");
    expect(markup).toContain("Fix failing CI before requesting more review.");
    expect(markup).toContain("Details");
    expect(markup).toContain("Suggest");
  });
});
