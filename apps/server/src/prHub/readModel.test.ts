import { describe, expect, it } from "vitest";
import {
  PullRequestKey,
  type PrAttentionState,
  type TrackedPullRequest,
  type PrHubSnapshot,
} from "@t3tools/contracts";
import { listPrHubPullRequests, prHubInvalidation, prHubOverview } from "./readModel.ts";
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

function snapshot(count = 5000): PrHubSnapshot {
  return {
    account: { host: "github.com", viewerId: 1, login: "me", generation: "account" },
    status: "ok",
    host: "github.com",
    viewerLogin: "me",
    lastPolledAt: null,
    recentlyResolved: [],
    pullRequests: Array.from({ length: count }, (_, i) =>
      makePr({
        attentionState: "review_requested",
        number: i + 1,
        key: PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${i + 1}`),
      }),
    ),
  };
}
describe("PR Hub bounded read model", () => {
  it("paginates 5000 PRs without duplicates and rejects changed revision/filter/account cursors", () => {
    const data = snapshot();
    const first = listPrHubPullRequests(data, "1", { limit: 100 });
    expect(first.pullRequests).toHaveLength(100);
    const second = listPrHubPullRequests(data, "1", { limit: 100, cursor: first.nextCursor! });
    expect(new Set([...first.pullRequests, ...second.pullRequests].map((pr) => pr.key)).size).toBe(
      200,
    );
    expect(listPrHubPullRequests(data, "2", { limit: 100, cursor: first.nextCursor! }).status).toBe(
      "cursor_stale",
    );
    expect(
      listPrHubPullRequests(data, "1", {
        limit: 100,
        filter: "authored",
        cursor: first.nextCursor!,
      }).status,
    ).toBe("cursor_stale");
    expect(listPrHubPullRequests(data, "1", { accountGeneration: "other" }).status).toBe(
      "cursor_stale",
    );
    expect(listPrHubPullRequests(data, "1", {}).pullRequests).toHaveLength(50);
  });
  it("publishes one changed key and bounds large invalidations", () => {
    const before = snapshot();
    const after = {
      ...before,
      pullRequests: before.pullRequests.map((pr, index) =>
        index === 20 ? { ...pr, title: "Changed" } : pr,
      ),
    };
    const event = prHubInvalidation(before, after, "2");
    expect(event.changedKeys).toEqual([before.pullRequests[20]!.key]);
    expect("pullRequests" in event).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(64 * 1024);
    const initial = prHubInvalidation(null, before, "1");
    expect(initial.resyncRequired).toBe(true);
    expect(initial.changedKeys).toEqual([]);
    expect(initial.counts.needs_you).toBe(5000);
  });
  it("never presents an unscanned empty inbox as complete monitoring", () => {
    const overview = prHubOverview(snapshot(0), "1");
    expect(overview.counts.all).toBe(0);
    expect(overview.coverage.every((scope) => scope.status === "not_scanned")).toBe(true);
    expect("pullRequests" in overview).toBe(false);
  });
});
