import {
  PR_HUB_BULK_MAX_KEYS,
  PullRequestKey,
  type PrHubComparisonIdentity,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  capPrSelection,
  PR_BULK_MERGE_LIMIT,
  PR_BULK_SELECTION_LIMIT,
  prBulkMergePlan,
  prSeenFingerprints,
  prSelectionState,
  prunePrSelection,
  runPrBulkMerge,
  selectPrRange,
  setPrSelection,
  togglePrSelection,
  type PrBulkMergeResult,
} from "./prQueueSelection";

const rows = ["a", "b", "c", "d", "e"];
const sorted = (set: ReadonlySet<string>) => [...set].toSorted();

describe("queue selection", () => {
  it("ticks and unticks one row", () => {
    const one = togglePrSelection(new Set<string>(), "b");
    expect(sorted(one)).toEqual(["b"]);
    expect(sorted(togglePrSelection(one, "b"))).toEqual([]);
    // The selection passed in is never changed.
    expect(sorted(one)).toEqual(["b"]);
  });

  it("extends from the last row ticked, in either direction", () => {
    expect(sorted(selectPrRange(rows, new Set(["b"]), "b", "d"))).toEqual(["b", "c", "d"]);
    expect(sorted(selectPrRange(rows, new Set(["d"]), "d", "b"))).toEqual(["b", "c", "d"]);
    expect(sorted(selectPrRange(rows, new Set(["a"]), "c", "c"))).toEqual(["a", "c"]);
  });

  it("ticks just the row when the last one ticked is gone", () => {
    expect(sorted(selectPrRange(rows, new Set(["a"]), null, "d"))).toEqual(["a", "d"]);
    expect(sorted(selectPrRange(rows, new Set(["a"]), "gone", "d"))).toEqual(["a", "d"]);
  });

  it("ticks or clears a whole section and reports its state", () => {
    const section = ["b", "c"];
    expect(prSelectionState(section, new Set(["a"]))).toBe("none");
    expect(prSelectionState(section, new Set(["a", "b"]))).toBe("some");
    const all = setPrSelection(new Set(["a"]), section, true);
    expect(prSelectionState(section, all)).toBe("all");
    expect(sorted(setPrSelection(all, section, false))).toEqual(["a"]);
    expect(prSelectionState([], new Set(["a"]))).toBe("none");
  });

  it("forgets rows that left the screen and keeps the same set otherwise", () => {
    const selection = new Set(["a", "c"]);
    expect(prunePrSelection(selection, rows)).toBe(selection);
    expect(sorted(prunePrSelection(selection, ["a", "b"]))).toEqual(["a"]);
    const empty = new Set<string>();
    expect(prunePrSelection(empty, [])).toBe(empty);
  });

  it("stops at what one bulk request takes, keeping what was already ticked", () => {
    const next = new Set(rows);
    expect(capPrSelection(new Set(["a"]), next)).toEqual({ selected: next, dropped: 0 });
    // "d" and "e" were ticked before; the rest fills up in screen order.
    const capped = capPrSelection(new Set(["d", "e"]), next, 3);
    expect(sorted(capped.selected)).toEqual(["a", "d", "e"]);
    expect(capped.dropped).toBe(2);
    expect(PR_BULK_SELECTION_LIMIT).toBe(PR_HUB_BULK_MAX_KEYS);
  });

  it("sends each row to mark seen with the attention it shows", () => {
    expect(
      prSeenFingerprints([
        {
          key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#1"),
          attentionFingerprint: "x",
        },
        {
          key: PullRequestKey.makeUnsafe("github:github.com/octo/repo#2"),
          attentionFingerprint: "y",
        },
      ]),
    ).toEqual({
      "github:github.com/octo/repo#1": "x",
      "github:github.com/octo/repo#2": "y",
    });
  });
});

function makePr(number: number, overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`),
    provider: "github",
    nodeId: `PR_${number}`,
    number,
    title: `Change ${number}`,
    url: `https://github.com/octo/repo/pull/${number}`,
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ready_to_merge",
    attentionBucket: "needs_you",
    primaryReason: "",
    nextAction: "",
    checkRollup: "success",
    reviewDecision: "approved",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    section: "ready",
    allowedMergeMethods: ["merge", "squash"],
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: `head-${number}`,
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

const preferences = { configured: null, lastUsed: {} } as const;

describe("prBulkMergePlan", () => {
  it("takes only the ready pull requests of the selection, in order", () => {
    const plan = prBulkMergePlan(
      [
        makePr(1),
        makePr(2, { section: "action" }),
        makePr(3, { section: "review", roles: [] }),
        makePr(4),
        makePr(5, { isDraft: true }),
        makePr(6, { state: "merged" }),
      ],
      preferences,
    );
    expect(plan.items.map((item) => [item.pr.number, item.method, item.blocked])).toEqual([
      [1, "squash", null],
      [4, "squash", null],
    ]);
    expect(plan.overLimit).toBe(0);
  });

  it("starts each one on the method its Merge dialog would", () => {
    const method = (
      overrides: Partial<TrackedPullRequest>,
      prefs: Parameters<typeof prBulkMergePlan>[1] = preferences,
    ) => prBulkMergePlan([makePr(1, overrides)], prefs).items[0]?.method;
    expect(method({}, { configured: "merge", lastUsed: {} })).toBe("merge");
    expect(method({}, { configured: null, lastUsed: { "github.com/octo/repo": "merge" } })).toBe(
      "merge",
    );
    // A preference the repository does not allow falls back to one it does.
    expect(method({ allowedMergeMethods: ["rebase"] }, { configured: "merge", lastUsed: {} })).toBe(
      "rebase",
    );
  });

  it("lists what it cannot merge, with the reason", () => {
    const plan = prBulkMergePlan(
      [
        makePr(1, { allowedMergeMethods: [] }),
        makePr(2, { headRefOid: null }),
        makePr(3, { provider: "gitlab" }),
      ],
      preferences,
    );
    expect(plan.items.map((item) => item.blocked)).toEqual([
      "The repository's merge methods are not known yet.",
      "Its latest commit is not known yet.",
      "Merge it from its own page.",
    ]);
  });

  it("merges at most the limit and says how many are left", () => {
    const plan = prBulkMergePlan(
      Array.from({ length: PR_BULK_MERGE_LIMIT + 3 }, (_, index) => makePr(index + 1)),
      preferences,
    );
    expect(plan.items).toHaveLength(PR_BULK_MERGE_LIMIT);
    expect(plan.overLimit).toBe(3);
  });
});

describe("runPrBulkMerge", () => {
  const comparison = (headOid: string): PrHubComparisonIdentity => ({
    baseRepository: "octo/repo",
    baseRef: "main",
    baseOid: "base",
    headRepository: "octo/repo",
    headRef: "feature",
    headOid,
    mergeBaseOid: "base",
    mode: "current_pr",
  });

  it("merges one at a time at the listed commit and goes on past a failure", async () => {
    const items = prBulkMergePlan(
      [
        makePr(1),
        makePr(2),
        makePr(3),
        makePr(4, { allowedMergeMethods: [] }),
        makePr(5),
        makePr(6),
      ],
      preferences,
    ).items;
    const order: string[] = [];
    const getFiles = vi.fn(async ({ key }: { key: string }) => {
      order.push(`read ${key.split("#")[1]}`);
      if (key.endsWith("#5")) return { files: [], comparison: undefined };
      // #2 received a push after it was listed.
      return {
        files: [],
        comparison: comparison(key.endsWith("#2") ? "pushed" : `head-${key.split("#")[1]}`),
      };
    });
    const merge = vi.fn(async ({ url }: { url: string }) => {
      order.push(`merge ${url.split("/").at(-1)}`);
      if (url.endsWith("/3")) throw new Error("Required checks have not passed.");
      return url.endsWith("/6") ? { actionWarning: "The branch was not deleted." } : {};
    });
    const results = new Map<string, PrBulkMergeResult[]>();
    await runPrBulkMerge(items, { getFiles, merge } as never, (key, result) =>
      results.set(key, [...(results.get(key) ?? []), result]),
    );

    expect(order).toEqual([
      "read 1",
      "merge 1",
      "read 2",
      "read 3",
      "merge 3",
      "read 5",
      "read 6",
      "merge 6",
    ]);
    expect(merge.mock.calls[0]?.[0]).toEqual({
      url: "https://github.com/octo/repo/pull/1",
      method: "squash",
      expectedComparison: comparison("head-1"),
    });
    expect(getFiles.mock.calls[0]?.[0]).toEqual({ key: items[0]!.pr.key, mode: "force" });
    expect([...results.values()].map((steps) => steps.at(-1))).toEqual([
      { state: "merged" },
      {
        state: "failed",
        message: "New commits were pushed since it was listed. Review it before merging.",
      },
      { state: "failed", message: "Required checks have not passed." },
      { state: "skipped", message: "The repository's merge methods are not known yet." },
      { state: "failed", message: "The forge did not provide the merge comparison." },
      { state: "merged", warning: "The branch was not deleted." },
    ]);
    expect(results.get(items[0]!.pr.key)?.[0]).toEqual({ state: "running" });
  });
});
