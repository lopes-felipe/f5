import {
  PullRequestKey,
  ThreadId,
  type PrHubSyncState,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  movePrQueueCursor,
  prQueueCollapsed,
  prQueueCommand,
  prRowChecks,
  prRowPrimaryAction,
  prRowReview,
  prStatusChecklist,
  prSyncPillDetail,
  prSyncPillLabel,
} from "./prQueueModel";

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
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "awaiting_review",
    attentionBucket: "waiting_on_others",
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
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: "fp",
    ...overrides,
  };
}

const theirs = { roles: [], author: "someone" } as const;

describe("prRowPrimaryAction", () => {
  const action = (overrides: Partial<TrackedPullRequest>) =>
    prRowPrimaryAction(makePr(overrides))?.kind ?? null;

  it.each<[string, Partial<TrackedPullRequest>, string | null]>([
    ["a review request", { ...theirs, viewerReviewRequested: true }, "review"],
    ["new commits after my review", { ...theirs, attentionState: "changes_pushed" }, "review"],
    [
      "a team request",
      { ...theirs, viewerReviewRequested: true, reviewRequestSource: "team" },
      "review",
    ],
    ["a mention", { ...theirs, attentionState: "mentioned" }, null],
    ["my conflicting PR", { attentionState: "merge_conflict" }, "resolve_conflicts"],
    ["my failing PR", { attentionState: "ci_failing" }, "fix_ci"],
    ["my PR behind its base", { attentionState: "branch_behind" }, "update_branch"],
    ["requested changes", { attentionState: "changes_requested" }, "address_feedback"],
    ["unresolved threads", { attentionState: "unresolved_comments" }, "address_feedback"],
    ["my ready PR", { attentionState: "ready_to_merge" }, "merge"],
    ["my draft", { attentionState: "draft", isDraft: true }, "mark_ready"],
    ["my PR awaiting review", { attentionState: "awaiting_review" }, null],
    ["a merged PR", { attentionState: "merged", state: "merged" }, null],
    [
      "an ignored PR",
      { attentionState: "ci_failing", ignoredAt: "2026-11-01T00:00:00.000Z" },
      null,
    ],
    ["an archived repository", { attentionState: "ci_failing", repositoryArchived: true }, null],
  ])("offers the right step for %s", (_name, overrides, expected) => {
    expect(action(overrides)).toBe(expected);
  });

  it("opens the running thread instead of starting a second agent", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(
      prRowPrimaryAction(makePr({ attentionState: "ci_failing" }), { runningThreadId: threadId }),
    ).toEqual({ kind: "open_thread", label: "Open thread", threadId });
    // Merging and reviewing are the viewer's own steps, running thread or not.
    expect(
      prRowPrimaryAction(makePr({ attentionState: "ready_to_merge" }), {
        runningThreadId: threadId,
      })?.kind,
    ).toBe("merge");
  });

  it("does not offer a branch update the forge cannot do", () => {
    expect(
      prRowPrimaryAction(makePr({ attentionState: "branch_behind", provider: "bitbucket" })),
    ).toBeNull();
  });
});

describe("row cells and checklist", () => {
  it("summarises review and checks", () => {
    expect(prRowReview(makePr({ reviewDecision: "approved" }))).toEqual({
      label: "Approved",
      tone: "success",
    });
    expect(prRowReview(makePr({ reviewRequestsCount: 2 })).label).toBe("Pending");
    expect(prRowReview(makePr({ reviewDecision: "none" })).tone).toBe("muted");
    expect(prRowChecks(makePr({ checkRollup: "failure" }))).toEqual({
      label: "Failed",
      tone: "danger",
    });
    expect(prRowChecks(makePr({ checkRollup: "pending" })).label).toBe("Running");
  });

  it("lists what blocks a merge and leaves out what does not apply", () => {
    const items = prStatusChecklist(
      makePr({
        reviewRequestsCount: 4,
        reviewRequestReviewers: ["ana", "bo", "cy", "di"],
        checkRollup: "failure",
        mergeable: "conflicting",
        unresolvedThreadCount: 2,
        mergeRequirements: {
          verification: "verified",
          mandatorySatisfied: false,
          checks: [],
          ruleTypes: [],
          explanation: "A required check has not run.",
        },
      }),
    );
    expect(items.map((item) => [item.id, item.tone, item.detail])).toEqual([
      ["review", "pending", "Waiting on ana, bo, cy and 1 more"],
      ["checks", "danger", "Some checks failed"],
      ["branch", "danger", "Conflicts with main"],
      ["threads", "warning", "2 unresolved"],
      ["requirements", "warning", "A required check has not run."],
    ]);
    expect(
      prStatusChecklist(makePr({ reviewDecision: "approved" })).map((item) => item.id),
    ).toEqual(["review", "checks", "branch"]);
    expect(
      prStatusChecklist(makePr({ mergeStateStatus: "BEHIND" })).find(
        (item) => item.id === "branch",
      ),
    ).toMatchObject({ tone: "warning", detail: "Behind main" });
  });
});

describe("sync pill", () => {
  const NOW = Date.parse("2026-11-14T12:00:00.000Z");
  const sync = (overrides: Partial<PrHubSyncState>): PrHubSyncState => ({
    state: "idle",
    lastSyncedAt: new Date(NOW - 120_000).toISOString(),
    nextSyncAt: null,
    resumeAt: null,
    pending: { searches: 0, hydrations: 0 },
    message: null,
    ...overrides,
  });

  it("stays calm while background work continues", () => {
    expect(prSyncPillLabel(sync({}), NOW)).toBe("Synced 2m ago");
    const backlog = sync({ state: "syncing", pending: { searches: 1, hydrations: 40 } });
    expect(prSyncPillLabel(backlog, NOW)).toBe("Synced 2m ago");
    expect(prSyncPillDetail(backlog)).toBe(
      "Still checking 1 search and 40 pull requests in the background. Nothing is wrong.",
    );
    expect(prSyncPillLabel(sync({ state: "syncing", lastSyncedAt: null }), NOW)).toBe("Syncing");
    expect(prSyncPillLabel(undefined, NOW)).toBe("Loading");
  });

  it("names the states that need attention", () => {
    expect(prSyncPillLabel(sync({ state: "rate_limited" }), NOW)).toBe("Rate limited");
    expect(prSyncPillLabel(sync({ state: "offline" }), NOW)).toBe("Offline");
    expect(prSyncPillLabel(sync({ state: "auth_required" }), NOW)).toBe("Not connected");
    expect(prSyncPillLabel(sync({ state: "error" }), NOW)).toBe("Sync failed");
    expect(prSyncPillDetail(sync({ state: "error", message: "GitHub returned HTTP 502." }))).toBe(
      "GitHub returned HTTP 502.",
    );
  });
});

describe("queue keyboard", () => {
  const key = (name: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key: name,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("maps the single-key shortcuts in the queue", () => {
    const commands = [
      "j",
      "k",
      "ArrowDown",
      "ArrowUp",
      " ",
      "Enter",
      "Escape",
      "/",
      "a",
      "m",
      "s",
      "e",
      "o",
      "r",
    ];
    expect(commands.map((name) => prQueueCommand(key(name), "queue"))).toEqual([
      "next",
      "previous",
      "next",
      "previous",
      "peek",
      "open",
      "back",
      "search",
      "primary",
      "merge",
      "snooze",
      "ignore",
      "forge",
      "refresh",
    ]);
    expect(prQueueCommand(key("]"), "queue")).toBeNull();
    expect(prQueueCommand(key("x"), "queue")).toBeNull();
  });

  it("leaves scrolling keys to the page and adds previous and next", () => {
    for (const name of ["j", "ArrowDown", " ", "Enter", "/"])
      expect(prQueueCommand(key(name), "page")).toBeNull();
    expect(prQueueCommand(key("]"), "page")).toBe("pageNext");
    expect(prQueueCommand(key("["), "page")).toBe("pagePrevious");
    expect(prQueueCommand(key("Escape"), "page")).toBe("back");
    expect(prQueueCommand(key("m"), "page")).toBe("merge");
  });

  it("ignores modified keys, which belong to the app and the browser", () => {
    expect(prQueueCommand(key("r", { metaKey: true }), "queue")).toBeNull();
    expect(prQueueCommand(key("a", { ctrlKey: true }), "queue")).toBeNull();
    expect(prQueueCommand(key("j", { shiftKey: true }), "queue")).toBeNull();
  });

  it("moves the cursor within the visible rows", () => {
    const keys = ["a", "b", "c"];
    expect(movePrQueueCursor(keys, null, 1)).toBe("a");
    expect(movePrQueueCursor(keys, "gone", -1)).toBe("a");
    expect(movePrQueueCursor(keys, "a", 1)).toBe("b");
    expect(movePrQueueCursor(keys, "c", 1)).toBe("c");
    expect(movePrQueueCursor(keys, "a", -1)).toBe("a");
    expect(movePrQueueCursor([], "a", 1)).toBeNull();
  });
});

describe("section collapse", () => {
  it("collapses the quiet sections until the user opens them", () => {
    expect(prQueueCollapsed({}, "review")).toBe(false);
    expect(prQueueCollapsed({}, "waiting")).toBe(false);
    expect(prQueueCollapsed({}, "team")).toBe(true);
    expect(prQueueCollapsed({ team: false, review: true }, "team")).toBe(false);
    expect(prQueueCollapsed({ team: false, review: true }, "review")).toBe(true);
  });
});
