import { describe, expect, it } from "vitest";
import { PullRequestKey, type PrHubSection, type TrackedPullRequest } from "@t3tools/contracts";

import {
  canViewerReview,
  comparePrPriority,
  derivePrWaitingSince,
  derivePrAttention,
  derivePrAttentionReasons,
  matchesPrHubFilter,
  prAttentionText,
  prHubSection,
  prHubSectionOf,
  PR_HUB_NEEDS_YOU_SECTIONS,
  PR_HUB_NEEDS_YOU_STATES,
  PR_HUB_SECTIONS,
  type RawPrFields,
} from "./prHub";

const basePr: RawPrFields = {
  actionableUnresolvedThreadCount: 0,
  headRefOid: null,
  viewerLastReviewedCommitOid: null,
  author: "octocat",
  isAuthor: false,
  isDraft: false,
  state: "open",
  checkRollup: "success",
  mergeable: "mergeable",
  mergeStateStatus: "CLEAN",
  mergePermission: "allowed",
  mergeRequirements: {
    verification: "verified",
    mandatorySatisfied: true,
    checks: [],
    ruleTypes: [],
    explanation: "verified",
  },
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

  it.each([
    [{ checkRollup: "failure" }, "ci_failing"],
    [{ mergeable: "conflicting" }, "merge_conflict"],
    [{ mergeStateStatus: "BEHIND" }, "branch_behind"],
    [{ reviewDecision: "changes_requested" }, "changes_requested"],
    [{ reviewDecision: "approved" }, "ready_to_merge"],
    [{}, "unresolved_comments"],
  ] as const)(
    "orders unresolved author feedback behind blockers and approval: %j",
    (overrides, expected) => {
      expect(
        derive({ isAuthor: true, actionableUnresolvedThreadCount: 5, ...overrides }).attentionState,
      ).toBe(expected);
    },
  );

  it.each([
    ["head", "head", "reviewed_waiting"],
    ["new", "old", "changes_pushed"],
    [null, "old", "reviewed_waiting"],
    ["new", null, "reviewed_waiting"],
  ] as const)(
    "compares reviewed revisions %s / %s",
    (headRefOid, viewerLastReviewedCommitOid, state) => {
      expect(
        derive({ viewerHasReviewed: true, headRefOid, viewerLastReviewedCommitOid }).attentionState,
      ).toBe(state);
    },
  );

  it.each(["BLOCKED", "UNKNOWN", "", "BEHIND"])(
    "never calls a blocked or unknown PR ready: %s",
    (mergeStateStatus) => {
      expect(
        derive({ isAuthor: true, reviewDecision: "approved", mergeStateStatus }).attentionState,
      ).not.toBe("ready_to_merge");
    },
  );

  it("tracks exactly the needs-you states produced by the fixture matrix", () => {
    const matrix: Partial<RawPrFields>[] = [
      { state: "merged" },
      { state: "closed" },
      { isAuthor: true, isDraft: true },
      { isAuthor: true, checkRollup: "failure" },
      { isAuthor: true, mergeable: "conflicting" },
      { isAuthor: true, mergeStateStatus: "BEHIND" },
      { isAuthor: true, reviewDecision: "changes_requested" },
      { isAuthor: true, reviewDecision: "approved" },
      { isAuthor: true, actionableUnresolvedThreadCount: 1 },
      { isAuthor: true },
      { viewerReviewRequested: true },
      { viewerReviewRequested: true, viewerHasReviewed: true },
      { viewerHasReviewed: true, headRefOid: "new", viewerLastReviewedCommitOid: "old" },
      { viewerHasReviewed: true },
      {},
    ];
    expect(
      new Set(
        matrix
          .map(derive)
          .filter((pr) => pr.attentionBucket === "needs_you")
          .map((pr) => pr.attentionState),
      ),
    ).toEqual(PR_HUB_NEEDS_YOU_STATES);
  });

  it("uses one review eligibility predicate for all lifecycle and relationship combinations", () => {
    for (const state of ["open", "closed", "merged"] as const) {
      for (const isAuthor of [false, true]) {
        for (const viewerReviewRequested of [false, true]) {
          for (const attentionState of [
            "changes_pushed",
            "review_requested",
            "reviewed_waiting",
          ] as const) {
            expect(
              canViewerReview({
                state,
                roles: isAuthor ? ["author"] : [],
                viewerReviewRequested,
                attentionState,
              }),
            ).toBe(
              state === "open" &&
                !isAuthor &&
                (viewerReviewRequested || attentionState === "changes_pushed"),
            );
          }
        }
      }
    }
  });

  it("derives waiting timestamps from data, with no elapsed-time escalation", () => {
    const input = {
      ...basePr,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      headCommittedAt: null,
    };
    expect(derivePrWaitingSince({ ...input, roles: ["author"] })).toBe(input.createdAt);
    expect(derivePrWaitingSince({ ...input, viewerHasReviewed: true })).toBe(input.updatedAt);
    expect(derivePrWaitingSince({ ...input, roles: ["author"], isDraft: true })).toBeNull();
    expect(derivePrWaitingSince({ ...input, viewerHasReviewed: true, state: "closed" })).toBeNull();
  });
});

describe("attention reasons", () => {
  it("keeps simultaneous blockers in precedence order and stable observation times", () => {
    const input = {
      ...basePr,
      isAuthor: true,
      checkRollup: "failure" as const,
      mergeable: "conflicting" as const,
      actionableUnresolvedThreadCount: 3,
    };
    const first = derivePrAttentionReasons(input, {
      at: "2026-01-01T00:00:00.000Z",
      url: "https://github.com/org/repo/pull/1",
      verified: true,
    });
    expect(first.map((reason) => reason.code)).toEqual([
      "ci_failing",
      "merge_conflict",
      "unresolved_comments",
    ]);
    const next = derivePrAttentionReasons(
      { ...input, actionableUnresolvedThreadCount: 2 },
      {
        at: "2026-01-02T00:00:00.000Z",
        url: "https://github.com/org/repo/pull/1",
        verified: true,
        previous: first,
      },
    );
    expect(next).toEqual(first);
    expect(prAttentionText(next[2]!.code, 2).nextAction).toBe(
      "Address 2 unresolved review comments",
    );
  });
  it("identifies who acts next without treating degraded evidence as verified", () => {
    expect(
      derivePrAttentionReasons(
        { ...basePr, isAuthor: true },
        { at: "2026-01-01T00:00:00.000Z", url: "url", verified: false },
      )[0],
    ).toMatchObject({ actor: "reviewer", action: "wait", verification: "unverified" });
    expect(
      derivePrAttentionReasons(
        { ...basePr, viewerHasReviewed: true },
        { at: "2026-01-01T00:00:00.000Z", url: "url", verified: true },
      )[0]?.actor,
    ).toBe("author");
  });
});

it("retains stable observation times for provider evidence independent of response ordering", () => {
  const input = { ...basePr, isAuthor: true, actionableUnresolvedThreadCount: 2 };
  const observation = {
    at: "2026-01-01T00:00:00.000Z",
    url: "pr-url",
    verified: true,
    evidence: {
      unresolved_comments: [
        { id: "b", url: "comment-b" },
        { id: "a", url: "comment-a" },
      ],
    },
  };
  const first = derivePrAttentionReasons(input, observation);
  const next = derivePrAttentionReasons(input, {
    ...observation,
    at: "2026-01-02T00:00:00.000Z",
    previous: first,
    evidence: { unresolved_comments: [...observation.evidence.unresolved_comments].reverse() },
  });
  expect(next).toEqual(first);
  expect(next[0]?.evidence).toEqual([
    { id: "a", url: "comment-a" },
    { id: "b", url: "comment-b" },
  ]);
});

describe("team review requests", () => {
  const requested = { viewerReviewRequested: true };

  it("is informational until the viewer is asked personally", () => {
    expect(derive({ ...requested, reviewRequestSource: "team" })).toMatchObject({
      attentionState: "team_review_requested",
      attentionBucket: "informational",
      primaryReason: "Review requested from your team",
    });
    expect(derive({ ...requested, reviewRequestSource: "direct" }).attentionState).toBe(
      "review_requested",
    );
    // Rows from before the distinction existed stay the viewer's.
    expect(derive(requested).attentionState).toBe("review_requested");
  });

  it("never asks for a re-review on behalf of a team, but still reports new commits", () => {
    const reviewed = {
      ...requested,
      reviewRequestSource: "team" as const,
      viewerHasReviewed: true,
    };
    expect(derive(reviewed).attentionState).toBe("team_review_requested");
    expect(
      derive({ ...reviewed, headRefOid: "new", viewerLastReviewedCommitOid: "old" }),
    ).toMatchObject({ attentionState: "changes_pushed", attentionBucket: "needs_you" });
    expect(
      derive({ ...requested, reviewRequestSource: "direct", viewerHasReviewed: true })
        .attentionState,
    ).toBe("re_review_requested");
  });

  it("names the team's reviewers as the next actor", () => {
    expect(
      derivePrAttentionReasons(
        { ...basePr, ...requested, reviewRequestSource: "team" },
        { at: "2026-01-01T00:00:00.000Z", url: "url", verified: true },
      )[0],
    ).toMatchObject({ code: "team_review_requested", actor: "reviewer", action: "review" });
  });
});

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function tracked(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${overrides.number ?? 1}`),
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
    attentionState: "mentioned",
    attentionBucket: "informational",
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
    createdAt: daysAgo(10),
    updatedAt: daysAgo(1),
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

const mine = { roles: ["author" as const], author: "me" };
const needsYou = { attentionBucket: "needs_you" as const };
const waiting = { attentionBucket: "waiting_on_others" as const };

describe("prHubSection", () => {
  const section = (overrides: Partial<TrackedPullRequest>, staleAfterDays = 30) =>
    prHubSection(tracked(overrides), { now: NOW, staleAfterDays });

  it.each<[string, Partial<TrackedPullRequest>, PrHubSection]>([
    [
      "a personal review request",
      { ...needsYou, attentionState: "review_requested", viewerReviewRequested: true },
      "review",
    ],
    [
      "a request with a promoted team",
      {
        ...needsYou,
        attentionState: "review_requested",
        viewerReviewRequested: true,
        reviewRequestSource: "direct",
      },
      "review",
    ],
    ["new commits since my review", { ...needsYou, attentionState: "changes_pushed" }, "review"],
    [
      "a re-review request",
      { ...needsYou, attentionState: "re_review_requested", viewerReviewRequested: true },
      "review",
    ],
    ["my PR that is ready", { ...mine, ...needsYou, attentionState: "ready_to_merge" }, "ready"],
    ["my PR with failing CI", { ...mine, ...needsYou, attentionState: "ci_failing" }, "action"],
    ["my PR with conflicts", { ...mine, ...needsYou, attentionState: "merge_conflict" }, "action"],
    ["my draft", { ...mine, attentionState: "draft", isDraft: true }, "drafts"],
    [
      "my PR awaiting review",
      { ...mine, ...waiting, attentionState: "awaiting_review" },
      "waiting",
    ],
    ["a PR I reviewed", { ...waiting, attentionState: "reviewed_waiting" }, "waiting"],
    [
      "a team-only request",
      {
        attentionState: "team_review_requested",
        viewerReviewRequested: true,
        reviewRequestSource: "team",
      },
      "team",
    ],
    ["a mention", { attentionState: "mentioned" }, "other"],
    ["a merged PR", { ...mine, state: "merged", attentionState: "merged" }, "other"],
    [
      "an archived repository",
      { ...mine, ...needsYou, attentionState: "ci_failing", repositoryArchived: true },
      "other",
    ],
  ])("puts %s in its section", (_name, overrides, expected) => {
    expect(section(overrides)).toBe(expected);
  });

  it("gives a failing draft to Your action before Drafts", () => {
    expect(section({ ...mine, ...needsYou, attentionState: "ci_failing", isDraft: true })).toBe(
      "action",
    );
  });

  it("files anything quiet for longer than the setting under Stale, unless disabled", () => {
    const quiet = {
      ...needsYou,
      attentionState: "review_requested" as const,
      viewerReviewRequested: true,
      updatedAt: daysAgo(31),
    };
    expect(section(quiet)).toBe("stale");
    expect(section({ ...quiet, updatedAt: daysAgo(29) })).toBe("review");
    expect(section(quiet, 60)).toBe("review");
    expect(section(quiet, 0)).toBe("review");
    // Closed work is history, not stale work.
    expect(section({ ...quiet, state: "closed", attentionState: "closed" })).toBe("other");
  });

  it("prefers the section stamped by the server over a local guess", () => {
    const quiet = tracked({
      ...mine,
      ...needsYou,
      attentionState: "ci_failing",
      updatedAt: daysAgo(40),
    });
    expect(prHubSectionOf(quiet, NOW)).toBe("stale");
    expect(prHubSectionOf({ ...quiet, section: "action" }, NOW)).toBe("action");
  });

  it("lists the sections in display order, with three that need the viewer", () => {
    expect(PR_HUB_SECTIONS).toEqual([
      "review",
      "action",
      "ready",
      "waiting",
      "drafts",
      "team",
      "other",
      "stale",
    ]);
    expect([...PR_HUB_NEEDS_YOU_SECTIONS]).toEqual(["review", "action", "ready"]);
  });
});

describe("needs-you filters", () => {
  const review = tracked({
    ...needsYou,
    attentionState: "review_requested",
    viewerReviewRequested: true,
  });
  const team = tracked({
    attentionState: "team_review_requested",
    viewerReviewRequested: true,
    reviewRequestSource: "team",
  });
  const failing = tracked({ ...mine, ...needsYou, attentionState: "ci_failing" });
  const fossil = { ...failing, updatedAt: daysAgo(90) };
  const matches = (pr: TrackedPullRequest, filter: Parameters<typeof matchesPrHubFilter>[1]) =>
    matchesPrHubFilter(pr, filter, undefined, NOW);

  it("counts personal reviews and the viewer's own blocked work", () => {
    expect(matches(review, "needs_you")).toBe(true);
    expect(matches(review, "needs_my_review")).toBe(true);
    expect(matches(failing, "needs_you")).toBe(true);
    expect(matches(failing, "my_prs_need_action")).toBe(true);
    expect(matches(failing, "needs_my_review")).toBe(false);
  });

  it("leaves team requests and stale work out, but keeps them reachable", () => {
    expect(matches(team, "needs_you")).toBe(false);
    expect(matches(team, "needs_my_review")).toBe(false);
    expect(matches(team, "reviews")).toBe(true);
    expect(matches(fossil, "needs_you")).toBe(false);
    expect(matches(fossil, "my_prs_need_action")).toBe(false);
    expect(matches(fossil, "authored")).toBe(true);
  });
});

describe("comparePrPriority", () => {
  const order = (prs: TrackedPullRequest[]) =>
    prs.toSorted((a, b) => comparePrPriority(a, b, NOW)).map((pr) => pr.number);

  it("follows section order before anything else", () => {
    const rows = [
      tracked({
        number: 1,
        ...mine,
        ...needsYou,
        attentionState: "merge_conflict",
        updatedAt: daysAgo(60),
      }),
      tracked({ number: 2, attentionState: "mentioned" }),
      tracked({
        number: 3,
        attentionState: "team_review_requested",
        viewerReviewRequested: true,
        reviewRequestSource: "team",
      }),
      tracked({ number: 4, ...mine, attentionState: "draft", isDraft: true }),
      tracked({ number: 5, ...mine, ...waiting, attentionState: "awaiting_review" }),
      tracked({ number: 6, ...mine, ...needsYou, attentionState: "ready_to_merge" }),
      tracked({ number: 7, ...mine, ...needsYou, attentionState: "branch_behind" }),
      tracked({
        number: 8,
        ...needsYou,
        attentionState: "review_requested",
        viewerReviewRequested: true,
      }),
    ];
    expect(order(rows)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("orders by urgency inside a section", () => {
    expect(
      order([
        tracked({ number: 1, ...mine, ...needsYou, attentionState: "unresolved_comments" }),
        tracked({ number: 2, ...mine, ...needsYou, attentionState: "ci_failing" }),
        tracked({ number: 3, ...mine, ...needsYou, attentionState: "merge_conflict" }),
      ]),
    ).toEqual([3, 2, 1]);
  });

  it("puts the most recently updated first, not the longest wait", () => {
    const fossil = tracked({
      number: 1,
      ...mine,
      ...waiting,
      attentionState: "awaiting_review",
      waitingSince: daysAgo(25),
      updatedAt: daysAgo(20),
    });
    const fresh = tracked({
      number: 2,
      ...mine,
      ...waiting,
      attentionState: "awaiting_review",
      waitingSince: daysAgo(2),
      updatedAt: daysAgo(1),
    });
    expect(order([fossil, fresh])).toEqual([2, 1]);
  });
});
