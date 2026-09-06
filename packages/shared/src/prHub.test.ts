import { describe, expect, it } from "vitest";

import {
  canViewerReview,
  derivePrWaitingSince,
  derivePrAttention,
  derivePrAttentionReasons,
  prAttentionText,
  PR_HUB_NEEDS_YOU_STATES,
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
