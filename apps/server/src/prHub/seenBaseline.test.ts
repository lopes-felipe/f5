import { PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { parsePrSeenBaseline, prChangesSinceSeen, prSeenBaseline } from "./seenBaseline.ts";

const AT = "2026-11-14T08:00:00.000Z";

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
    roles: ["review_requested"],
    attentionState: "review_requested",
    attentionBucket: "needs_you",
    primaryReason: "",
    nextAction: "",
    checkRollup: "success",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: true,
    section: "review",
    reviewRequestReviewers: [],
    reviewRequestsCount: 1,
    commentsCount: 2,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    lastVerifiedAt: AT,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: "head-1",
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: AT,
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

const seen = (pr = makePr()) => prSeenBaseline(pr, AT);
const kinds = (pr: TrackedPullRequest, baseline = seen(), viewer: string | null = "me") =>
  prChangesSinceSeen(pr, baseline, viewer).map((change) => change.kind);

describe("prChangesSinceSeen", () => {
  it("reports nothing when the facts are what the viewer last saw", () => {
    expect(prChangesSinceSeen(makePr(), seen(), "me")).toEqual([]);
  });

  it("reads a pull request never opened as new only while it waits for the viewer", () => {
    for (const section of ["review", "action", "ready"] as const)
      expect(prChangesSinceSeen(makePr({ section }), null, "me")).toEqual([{ kind: "new" }]);
    for (const section of ["waiting", "drafts", "team", "other", "stale"] as const)
      expect(prChangesSinceSeen(makePr({ section }), null, "me")).toEqual([]);
    expect(prChangesSinceSeen(makePr({ state: "merged" }), null, "me")).toEqual([]);
  });

  it("counts new comments and notices new commits from someone else", () => {
    expect(
      prChangesSinceSeen(makePr({ commentsCount: 5, headRefOid: "head-2" }), seen(), "me"),
    ).toEqual([{ kind: "commits" }, { kind: "comments", count: 3 }]);
    // Fewer comments (one was deleted) is not activity.
    expect(kinds(makePr({ commentsCount: 1 }))).toEqual([]);
  });

  it("does not report the viewer's own pushes", () => {
    const mine = makePr({ author: "Me", headRefOid: "head-2" });
    expect(kinds(mine, seen(makePr({ author: "Me" })))).toEqual([]);
    expect(kinds(mine, seen(makePr({ author: "Me" })), null)).toEqual(["commits"]);
  });

  it("reports checks that started failing, and checks that recovered", () => {
    expect(kinds(makePr({ checkRollup: "failure" }))).toEqual(["ci_failed"]);
    expect(kinds(makePr({ checkRollup: "error" }))).toEqual(["ci_failed"]);
    const failed = seen(makePr({ checkRollup: "failure" }));
    expect(kinds(makePr({ checkRollup: "error" }), failed)).toEqual([]);
    expect(kinds(makePr({ checkRollup: "success" }), failed)).toEqual(["ci_passed"]);
    expect(kinds(makePr({ checkRollup: "pending" }), failed)).toEqual([]);
    // Pending to passing is the ordinary course of a run.
    expect(kinds(makePr(), seen(makePr({ checkRollup: "pending" })))).toEqual([]);
  });

  it("reports review decisions, conflicts and readiness, most important first", () => {
    expect(kinds(makePr({ reviewDecision: "approved" }))).toEqual(["approved"]);
    expect(kinds(makePr({ reviewDecision: "changes_requested" }))).toEqual(["changes_requested"]);
    expect(kinds(makePr({ mergeable: "conflicting" }))).toEqual(["conflict"]);
    expect(
      kinds(
        makePr({
          attentionState: "ready_to_merge",
          reviewDecision: "approved",
          checkRollup: "failure",
          mergeable: "conflicting",
          headRefOid: "head-2",
          commentsCount: 3,
        }),
      ),
    ).toEqual(["ready", "approved", "ci_failed", "conflict", "commits", "comments"]);
  });

  it("reports a merge or a close, and nothing else about a closed pull request", () => {
    expect(kinds(makePr({ state: "merged", commentsCount: 9 }))).toEqual(["merged"]);
    expect(kinds(makePr({ state: "closed" }))).toEqual(["closed"]);
    expect(kinds(makePr({ state: "merged" }), seen(makePr({ state: "merged" })))).toEqual([]);
  });

  it("never treats a fact the baseline lacks as a change", () => {
    const partial = { at: AT, state: "open" as const };
    expect(
      kinds(
        makePr({
          checkRollup: "failure",
          reviewDecision: "approved",
          mergeable: "conflicting",
          attentionState: "ready_to_merge",
          headRefOid: "head-2",
          commentsCount: 9,
        }),
        partial,
      ),
    ).toEqual([]);
  });

  it("ignores the placeholder facts of a row not yet read in full", () => {
    const found = makePr({
      lastVerifiedAt: null,
      checkRollup: "pending",
      reviewDecision: "none",
      mergeable: "unknown",
      headRefOid: null,
      commentsCount: 0,
    });
    expect(prSeenBaseline(found, AT)).toEqual({ at: AT, state: "open" });
    // Seen in full, then replaced by a lightweight row: nothing is known to have changed.
    expect(kinds(found)).toEqual([]);
    expect(kinds({ ...found, state: "merged" })).toEqual(["merged"]);
  });
});

describe("parsePrSeenBaseline", () => {
  it("round-trips a stored baseline", () => {
    expect(parsePrSeenBaseline(JSON.stringify(seen()))).toEqual(seen());
  });

  it("keeps what it can read and drops the rest", () => {
    expect(parsePrSeenBaseline(null)).toBeNull();
    expect(parsePrSeenBaseline("")).toBeNull();
    expect(parsePrSeenBaseline("not json")).toBeNull();
    expect(parsePrSeenBaseline("[1]")).toBeNull();
    expect(
      parsePrSeenBaseline(
        JSON.stringify({
          at: AT,
          state: "open",
          headRefOid: null,
          commentsCount: -1,
          checkRollup: 7,
          mergeable: "",
        }),
      ),
    ).toEqual({ at: AT, state: "open" });
  });
});
