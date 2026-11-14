import { describe, expect, it } from "vitest";
import {
  PullRequestKey,
  type PrAttentionReason,
  type PrHubSnapshot,
  type TrackedPullRequest,
} from "@t3tools/contracts";

import { applyPrHubRelevance, applyPrRelevance, prReviewRequestSource } from "./relevance.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const options = { viewerLogin: "me", directReviewTeams: [], staleAfterDays: 30, now: NOW };

const reason = (code: PrAttentionReason["code"]): PrAttentionReason => ({
  code,
  actor: "viewer",
  evidence: [],
  firstObservedAt: daysAgo(1),
  action: "review",
  verification: "verified",
});

function makePr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
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
    roles: ["team_review_requested"],
    attentionState: "review_requested",
    attentionBucket: "needs_you",
    primaryReason: "Review requested",
    nextAction: "Review",
    checkRollup: "success",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: true,
    reviewRequestReviewers: ["octo/platform"],
    reviewRequestsCount: 1,
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
    createdAt: daysAgo(3),
    updatedAt: daysAgo(1),
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: true,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

describe("review request source", () => {
  const source = (overrides: Partial<TrackedPullRequest>, teams: string[] = []) =>
    prReviewRequestSource(makePr(overrides), "me", new Set(teams));

  it("is null without a pending request", () => {
    expect(source({ viewerReviewRequested: false })).toBeNull();
  });
  it("is direct when the provider proved a personal request", () => {
    expect(source({ roles: ["review_requested", "team_review_requested"] })).toBe("direct");
    expect(source({ reviewRequestReviewers: ["octo/platform", "Me"] })).toBe("direct");
  });
  it("is team when only a team was asked, unless the viewer promoted that team", () => {
    expect(source({})).toBe("team");
    expect(source({}, ["octo/platform"])).toBe("direct");
    expect(source({ reviewRequestReviewers: ["octo/other"] }, ["octo/platform"])).toBe("team");
  });
  it("assumes a personal request when nothing proves a team one", () => {
    expect(source({ roles: [], reviewRequestReviewers: [] })).toBe("direct");
  });
});

describe("relevance projection", () => {
  it("moves a team-only request out of the viewer's queue without notifying", () => {
    const projected = applyPrRelevance(makePr({ reasons: [reason("review_requested")] }), options);
    expect(projected).toMatchObject({
      attentionState: "team_review_requested",
      attentionBucket: "informational",
      primaryReason: "Review requested from your team",
      reviewRequestSource: "team",
      section: "team",
      notificationPending: false,
    });
    expect(projected.reasons).toEqual([
      { ...reason("review_requested"), code: "team_review_requested", actor: "reviewer" },
    ]);
  });

  it("keeps new commits on a team request the viewer already reviewed in Review", () => {
    const projected = applyPrRelevance(
      makePr({
        attentionState: "re_review_requested",
        viewerHasReviewed: true,
        reasons: [reason("re_review_requested"), reason("changes_pushed")],
      }),
      options,
    );
    expect(projected).toMatchObject({
      attentionState: "changes_pushed",
      attentionBucket: "needs_you",
      section: "review",
      notificationPending: true,
    });
    expect(projected.reasons).toEqual([reason("changes_pushed")]);
  });

  it("brings a team request back when its team is promoted", () => {
    const stored = applyPrRelevance(makePr({ reasons: [reason("review_requested")] }), options);
    const promoted = applyPrRelevance(stored, {
      ...options,
      directReviewTeams: ["@Octo/Platform"],
    });
    expect(promoted).toMatchObject({
      attentionState: "review_requested",
      attentionBucket: "needs_you",
      reviewRequestSource: "direct",
      section: "review",
    });
    expect(promoted.reasons?.[0]).toMatchObject({ code: "review_requested", actor: "viewer" });
  });

  it("leaves the viewer's own pull requests and closed ones alone", () => {
    const mine = makePr({
      roles: ["author"],
      author: "me",
      attentionState: "ci_failing",
      viewerReviewRequested: false,
    });
    expect(applyPrRelevance(mine, options)).toMatchObject({
      attentionState: "ci_failing",
      reviewRequestSource: null,
      section: "action",
      notificationPending: true,
    });
    expect(
      applyPrRelevance(makePr({ state: "merged", attentionState: "merged" }), options),
    ).toMatchObject({ attentionState: "merged", section: "other", notificationPending: false });
  });

  it("files quiet pull requests under Stale and never notifies for them", () => {
    const quiet = makePr({ roles: ["review_requested"], updatedAt: daysAgo(31) });
    expect(applyPrRelevance(quiet, options)).toMatchObject({
      attentionState: "review_requested",
      section: "stale",
      notificationPending: false,
    });
    expect(applyPrRelevance(quiet, { ...options, staleAfterDays: 0 })).toMatchObject({
      section: "review",
      notificationPending: true,
    });
  });

  it("is idempotent and returns the same snapshot when nothing moves", () => {
    const snapshot: PrHubSnapshot = {
      status: "ok",
      host: "github.com",
      viewerLogin: "me",
      lastPolledAt: null,
      pullRequests: [makePr(), makePr({ roles: ["review_requested"], number: 2 })],
      recentlyResolved: [
        makePr({
          state: "merged",
          attentionState: "merged",
          number: 3,
          viewerReviewRequested: false,
        }),
      ],
    };
    const settings = { directReviewTeams: [], staleAfterDays: 30, now: NOW };
    const once = applyPrHubRelevance(snapshot, settings);
    expect(once).not.toBe(snapshot);
    expect(once.pullRequests.map((pr) => pr.section)).toEqual(["team", "review"]);
    const twice = applyPrHubRelevance(once, settings);
    expect(twice).toBe(once);
    // A changed setting re-projects only the rows it affects.
    const promoted = applyPrHubRelevance(once, {
      ...settings,
      directReviewTeams: ["octo/platform"],
    });
    expect(promoted.pullRequests[0]?.section).toBe("review");
    expect(promoted.pullRequests[1]).toBe(once.pullRequests[1]);
    expect(promoted.recentlyResolved).toBe(once.recentlyResolved);
  });
});
