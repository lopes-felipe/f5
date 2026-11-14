import { describe, expect, it } from "vitest";
import {
  PullRequestKey,
  type PrAttentionState,
  type TrackedPullRequest,
  type PrHubSnapshot,
} from "@t3tools/contracts";
import { listPrHubPullRequests, prHubInvalidation, prHubOverview } from "./readModel.ts";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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
    updatedAt: daysAgo(1),
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
  it("combines draft/review filters and GitHub-style qualifiers before pagination", () => {
    const data: PrHubSnapshot = {
      ...snapshot(0),
      pullRequests: [
        makePr({
          attentionState: "ready_to_merge",
          author: "ME",
          reviewDecision: "approved",
          labels: ["needs design", "size:S"],
          title: "Fix layout",
        }),
        makePr({ attentionState: "draft", isDraft: true, labels: ["bug"] }),
      ],
    };
    const query =
      'layout author:me draft:false review:approved status:success label:"needs design" label:size:S,size:XS -label:bug';
    expect(
      listPrHubPullRequests(data, "1", { query, draft: "hide", review: "approved", limit: 1 })
        .pullRequests,
    ).toHaveLength(1);
    expect(listPrHubPullRequests(data, "1", { query: "size:S" }).pullRequests).toHaveLength(0);
    expect(
      listPrHubPullRequests(data, "1", { query: "layout author:me fix" }).pullRequests,
    ).toHaveLength(1);
    expect(listPrHubPullRequests(data, "1", { query: "-author:me" }).pullRequests).toHaveLength(1);
    expect(
      listPrHubPullRequests(data, "1", { query: "-draft:true -review:required" }).pullRequests,
    ).toHaveLength(1);
    const colonData = {
      ...data,
      pullRequests: [
        makePr({
          attentionState: "ready_to_merge",
          title: "fix:crash in area:org/name is:open",
        }),
      ],
    };
    expect(
      listPrHubPullRequests(colonData, "1", { query: "fix:crash area:org/name is:open" })
        .pullRequests,
    ).toHaveLength(1);
    expect(
      listPrHubPullRequests(data, "1", { query: 'label:"needs,design"' }).pullRequests,
    ).toHaveLength(0);
    expect(listPrHubPullRequests(data, "1", { query: "draft:invalid" }).pullRequests).toHaveLength(
      0,
    );
    expect(
      listPrHubPullRequests(data, "1", { query: "review:__proto__" }).pullRequests,
    ).toHaveLength(0);
  });
  describe("queue sections", () => {
    const key = (number: number) =>
      PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`);
    const row = (
      number: number,
      overrides: Partial<TrackedPullRequest> & { attentionState: PrAttentionState },
    ) => makePr({ number, key: key(number), ...overrides });
    const mine = { roles: ["author" as const], author: "me" };
    const data: PrHubSnapshot = {
      ...snapshot(0),
      pullRequests: [
        row(1, { attentionState: "review_requested", reviewRequestSource: "direct" }),
        row(2, {
          attentionState: "team_review_requested",
          attentionBucket: "informational",
          viewerReviewRequested: true,
          reviewRequestSource: "team",
        }),
        row(3, { ...mine, attentionState: "ci_failing" }),
        row(4, { ...mine, attentionState: "ready_to_merge" }),
        row(5, {
          ...mine,
          attentionState: "awaiting_review",
          attentionBucket: "waiting_on_others",
        }),
        row(6, {
          ...mine,
          attentionState: "draft",
          attentionBucket: "informational",
          isDraft: true,
        }),
        row(7, { attentionState: "mentioned", attentionBucket: "informational" }),
        row(8, { ...mine, attentionState: "ci_failing", updatedAt: daysAgo(45) }),
        row(9, { attentionState: "review_requested", ignoredAt: daysAgo(1) }),
        row(10, { attentionState: "review_requested", snoozedUntil: daysAgo(-1) }),
        row(11, { attentionState: "review_requested", updatedAt: daysAgo(3) }),
      ],
    };

    it("counts each section once and builds the badge from review, action and ready", () => {
      const overview = prHubOverview(data, "1");
      expect(overview.sectionCounts).toEqual({
        review: 2,
        action: 1,
        ready: 1,
        waiting: 1,
        drafts: 1,
        team: 1,
        other: 1,
        stale: 1,
      });
      // Team, stale, ignored and snoozed rows never reach the badge.
      expect(overview.counts.needs_you).toBe(4);
    });

    it("lists one section of the active queue and stamps it on every row", () => {
      const review = listPrHubPullRequests(data, "1", { section: "review" }).pullRequests;
      expect(review.map((pr) => pr.number)).toEqual([1, 11]);
      expect(review.every((pr) => pr.section === "review")).toBe(true);
      expect(
        listPrHubPullRequests(data, "1", { section: "stale" }).pullRequests.map((pr) => pr.number),
      ).toEqual([8]);
      expect(
        listPrHubPullRequests(data, "1", {
          section: "review",
          visibility: "ignored",
        }).pullRequests.map((pr) => pr.number),
      ).toEqual([9]);
    });

    it("orders by section, then urgency, then most recently updated", () => {
      const ordered = listPrHubPullRequests(data, "1", { visibility: "active" }).pullRequests;
      expect(ordered.map((pr) => pr.number)).toEqual([1, 11, 3, 4, 5, 6, 2, 7, 8]);
    });

    it("filters by repository with the repo: qualifier", () => {
      const other = makePr({
        attentionState: "review_requested",
        number: 20,
        key: PullRequestKey.makeUnsafe("github:github.com/acme/web#20"),
        repository: { owner: "acme", repo: "web", nameWithOwner: "acme/web" },
      });
      const mixed = { ...data, pullRequests: [...data.pullRequests, other] };
      const numbers = (query: string) =>
        listPrHubPullRequests(mixed, "1", { query, visibility: "active", limit: 100 })
          .pullRequests.map((pr) => pr.number)
          .toSorted((a, b) => a - b);
      expect(numbers("repo:acme/web")).toEqual([20]);
      expect(numbers("repo:WEB")).toEqual([20]);
      expect(numbers("-repo:acme/web")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11]);
      expect(numbers("repo:acme/other")).toEqual([]);
    });
  });
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
