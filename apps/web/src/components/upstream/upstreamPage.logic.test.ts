import { describe, expect, it } from "vitest";

import { compactUpstreamSearch, validateUpstreamSearch } from "./upstreamSearch";
import {
  actionTargets,
  activeFilterChips,
  adjacentList,
  adjustCounts,
  bulkActionsForList,
  canAcceptSuggestion,
  canMoveFocusAfterDecision,
  decisionBatches,
  decisionToastTitle,
  equivalentFromLink,
  extendSelection,
  filterFromSearch,
  focusAfterRemoval,
  hasActiveFilters,
  headerCheckState,
  ledgerChipLabel,
  moveFocus,
  portableTopicIds,
  portLimitError,
  predictedState,
  preselectedSkipReason,
  promptLimitError,
  reconcileFocus,
  runDisabledReason,
  runStatus,
  selectRange,
  shortRepository,
  startAllReady,
  suggestionChipLabel,
  toggleId,
  toggleValue,
  topicCount,
  topicStates,
  unseenNote,
  upstreamSettingsOverrides,
  watchFromBlocked,
  withoutFilters,
  withoutTopics,
} from "./upstreamPage.logic";

const link = (outcome: { kind: "pr" | "equivalent" | "not-applicable" | "blocked"; detail: string } | null, prNumber: number | null = null) =>
  ({
    threadId: "thread-1",
    epoch: 1,
    threadTitle: "Port",
    threadStatus: "completed",
    branch: "f5/upstream-pr-1",
    prNumber,
    prUrl: null,
    prState: null,
    outcome,
  }) as never;

describe("upstream page logic", () => {
  it("formats suggestion chips with a confidence percentage", () => {
    const base = { reason: "", userImpact: "medium", areas: [], model: "m" } as const;
    expect(suggestionChipLabel({ ...base, status: "port", confidence: 0.92 })).toBe("Port 92%");
    expect(suggestionChipLabel({ ...base, status: "skip", reasonKey: "mobile", confidence: 0.97 })).toBe("Skip: mobile 97%");
    expect(suggestionChipLabel({ ...base, status: "skip", confidence: 0.5 })).toBe("Skip 50%");
    expect(suggestionChipLabel({ ...base, status: "equivalent", confidence: 0.7 })).toBe("Equivalent 70%");
  });

  it("selects ranges from the anchor in list order", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect([...selectRange(ids, new Set(), "b", "d")]).toEqual(["b", "c", "d"]);
    expect([...selectRange(ids, new Set(["a"]), "d", "b")].toSorted()).toEqual(["a", "b", "c", "d"]);
    expect([...selectRange(ids, new Set(), null, "c")]).toEqual(["c"]);
    expect([...selectRange(ids, new Set(), "gone", "c")]).toEqual(["c"]);
    expect([...selectRange(ids, new Set(["a"]), "b", "gone")]).toEqual(["a"]);
    expect([...toggleId(new Set(["a"]), "a")]).toEqual([]);
    expect([...toggleId(new Set(["a"]), "b")]).toEqual(["a", "b"]);
  });

  it("extends the selection while moving focus", () => {
    const ids = ["a", "b", "c"];
    const down = extendSelection(ids, new Set(), "a", 1);
    expect(down.focused).toBe("b");
    expect([...down.selected]).toEqual(["a", "b"]);
    const up = extendSelection(ids, down.selected, "b", -1);
    expect(up.focused).toBe("a");
    expect([...up.selected]).toEqual(["a", "b"]);
    expect(extendSelection(ids, new Set(), null, 1)).toEqual({ focused: "a", selected: new Set(["a"]) });
    expect(headerCheckState(ids, new Set())).toBe("none");
    expect(headerCheckState(ids, new Set(["a"]))).toBe("some");
    expect(headerCheckState(ids, new Set(ids))).toBe("all");
    expect(headerCheckState([], new Set())).toBe("none");
  });

  it("offers bulk actions that apply to each list", () => {
    expect(bulkActionsForList("inbox")).toEqual(["accept", "port", "skip", "watch", "decline", "equivalent"]);
    expect(bulkActionsForList("ready")).toContain("startPort");
    expect(bulkActionsForList("in-progress")).toContain("copyPrompt");
    expect(bulkActionsForList("watch")).not.toContain("watch");
    expect(bulkActionsForList("skipped")).toContain("reopen");
    expect(adjacentList("inbox", -1)).toBe("skipped");
    expect(adjacentList("skipped", 1)).toBe("inbox");
    expect(adjacentList("ready", 1)).toBe("in-progress");
  });

  it("predicts where a decision moves a topic, for optimistic updates", () => {
    const suggestion = (status: "port" | "skip" | "watch" | "equivalent", extra: object = {}) => ({
      topic: { suggestion: { status, reason: "", userImpact: "low" as const, confidence: 1, areas: [], model: "m", ...extra } },
    });
    const inbox = { state: "inbox" as const, topic: {} };
    expect(predictedState(inbox, { kind: "port" })).toBe("ready");
    expect(predictedState(inbox, { kind: "skip", reasonKey: "docs" })).toBe("skipped");
    expect(predictedState(inbox, { kind: "declined", reason: "no" })).toBe("skipped");
    expect(predictedState(inbox, { kind: "watch" })).toBe("watch");
    expect(predictedState(inbox, { kind: "equivalent" })).toBe("done");
    expect(predictedState(inbox, { kind: "inbox" })).toBeNull();
    expect(predictedState({ state: "in-progress", topic: {} }, { kind: "port", scope: "x" })).toBeNull();
    expect(predictedState({ state: "inbox", ...suggestion("port") }, "accept")).toBe("ready");
    expect(predictedState({ state: "inbox", ...suggestion("skip", { reasonKey: "docs" }) }, "accept")).toBe("skipped");
    expect(predictedState({ state: "inbox", ...suggestion("skip") }, "accept")).toBeNull();
    expect(predictedState({ state: "inbox", ...suggestion("port", { triageError: "x" }) }, "accept")).toBeNull();
    expect(predictedState(inbox, "accept")).toBeNull();
    // The row's quick Accept and the detail pane use the same rule as the prediction.
    expect(canAcceptSuggestion(suggestion("skip").topic.suggestion)).toBe(false);
    expect(canAcceptSuggestion(suggestion("skip", { reasonKey: "docs" }).topic.suggestion)).toBe(true);
    expect(canAcceptSuggestion(suggestion("watch", { triageError: "x" }).topic.suggestion)).toBe(false);
    expect(canAcceptSuggestion(undefined)).toBe(false);
  });

  it("moves counts and drops removed rows from loaded pages", () => {
    const counts = { inbox: 3, ready: 0, "in-progress": 0, watch: 0, done: 0, skipped: 1 };
    expect(
      adjustCounts(counts, [
        { from: "inbox", to: "ready" },
        { from: "inbox", to: "skipped" },
      ]),
    ).toEqual({ ...counts, inbox: 1, ready: 1, skipped: 2 });
    const row = (id: string, status: string, areas: string[]) =>
      ({ topic: { id, suggestion: { status, userImpact: "high", areas } } }) as never;
    const facets = {
      suggestion: { port: 2, skip: 1, watch: 0, equivalent: 0, none: 0 },
      impact: { high: 3, medium: 0, low: 0, none: 0 },
      areas: [
        { area: "terminal", count: 2 },
        { area: "git", count: 1 },
      ],
    };
    const page = (topics: never[], nextCursor: string | null) => ({ revision: "r", status: "ok" as const, nextCursor, total: 3, facets, topics });
    const data = {
      pageParams: [null, "c1"],
      pages: [page([row("a", "port", ["git"]), row("b", "port", ["terminal"])], "c1"), page([row("c", "skip", ["terminal"])], null)],
    };
    const next = withoutTopics(data as never, new Set(["b", "c", "unloaded"]));
    expect(next?.pages.map((entry) => entry.topics.length)).toEqual([1, 0]);
    expect(next?.pages.map((entry) => entry.total)).toEqual([1, 1]);
    expect(next?.pages[0]?.facets).toEqual({
      suggestion: { port: 1, skip: 0, watch: 0, equivalent: 0, none: 0 },
      impact: { high: 1, medium: 0, low: 0, none: 0 },
      areas: [
        { area: "terminal", count: 0 },
        { area: "git", count: 1 },
      ],
    });
    expect(next?.pageParams).toEqual(data.pageParams);
    expect(withoutTopics(data as never, new Set(["unloaded"]))).toBe(data);
    expect(withoutTopics(undefined, new Set(["a"]))).toBeUndefined();
  });

  it("turns search params into the server filter and removable chips", () => {
    const search = {
      q: "  terminal ",
      suggestion: ["skip", "none"] as const,
      impact: ["high"] as const,
      area: "server",
      question: true as const,
      by: "llm" as const,
    };
    expect(filterFromSearch(search)).toEqual({
      query: "terminal",
      suggestion: ["skip", "none"],
      impact: ["high"],
      area: "server",
      hasQuestion: true,
      decidedBy: "llm",
    });
    expect(filterFromSearch({ q: "   " })).toEqual({});
    expect(hasActiveFilters({})).toBe(false);
    const chips = activeFilterChips(search);
    expect(chips.map((chip) => chip.label)).toEqual([
      "“terminal”",
      "Skip",
      "No suggestion",
      "High impact",
      "Area: server",
      "Has question",
      "Automatic (LLM)",
    ]);
    const withList = { ...search, list: "inbox" as const, sort: "oldest" as const };
    expect(chips[1]!.remove(withList).suggestion).toEqual(["none"]);
    expect(chips[3]!.remove(withList)).not.toHaveProperty("impact");
    expect(withoutFilters(withList)).toEqual({ list: "inbox", sort: "oldest" });
    expect(toggleValue(["port"], "skip")).toEqual(["port", "skip"]);
    expect(toggleValue(["port", "skip"], "port")).toEqual(["skip"]);
    expect(toggleValue(undefined, "port")).toEqual(["port"]);
  });

  it("validates and compacts the URL search params", () => {
    expect(
      validateUpstreamSearch({
        list: "skipped",
        q: "x",
        suggestion: ["skip", "bogus", "skip"],
        impact: "high,low",
        sort: "confidence",
        auto: "true",
        conflict: true,
        topic: "not a topic",
      }),
    ).toEqual({ list: "skipped", q: "x", suggestion: ["skip"], impact: ["high", "low"], sort: "confidence", by: "llm", conflict: true });
    expect(validateUpstreamSearch({ sort: "random", by: "nobody" })).toEqual({});
    expect(compactUpstreamSearch({ list: "inbox", q: " ", suggestion: [], sort: "newest" })).toEqual({ sort: "newest" });
  });

  it("summarizes the header state", () => {
    const relative = () => "5m ago";
    const next = () => "Tue 09:00";
    const run = { status: "succeeded", finishedAt: "2026-10-26T10:00:00Z", startedAt: "2026-10-26T09:59:00Z", remainingCount: 0 } as never;
    expect(runStatus({ activeRun: null, lastRun: run, nextRunAt: "x", occurrence: null }, relative, next)).toEqual({
      tone: "idle",
      label: "Synced 5m ago · next Tue 09:00",
    });
    expect(
      runStatus({ activeRun: { remainingCount: 40 } as never, lastRun: run, nextRunAt: null, occurrence: null }, relative, next),
    ).toEqual({ tone: "running", label: "Triaging… 40 left" });
    expect(runStatus({ activeRun: null, lastRun: null, nextRunAt: null, occurrence: null }, relative, next).tone).toBe("never");
    expect(
      runStatus({ activeRun: null, lastRun: run, nextRunAt: null, occurrence: { status: "failed" } as never }, relative, next).tone,
    ).toBe("failed");
    expect(shortRepository("https://github.com/pingdotgg/t3code.git")).toBe("pingdotgg/t3code");
    const publication = { prNumber: 228, unpublishedOps: 11, pausedReason: null } as never;
    expect(ledgerChipLabel(publication)).toBe("#228 · 11 unpublished");
    expect(ledgerChipLabel({ prNumber: null, unpublishedOps: 0, pausedReason: null } as never)).toBeNull();
    expect(runDisabledReason({ readOnly: false, busy: false, overview: { activeRun: null, remoteStatus: "ok" } })).toBeNull();
    expect(runDisabledReason({ readOnly: false, busy: false, overview: { activeRun: null, remoteStatus: "missing" } })).toMatch(
      /missing/u,
    );
    expect(startAllReady(Array.from({ length: 25 }, (_, index) => `t${index}`))).toMatchObject({ capped: true });
    expect(startAllReady(["a"]).ids).toEqual(["a"]);
    expect(decisionToastTitle({ kind: "skip", reasonKey: "docs" }, 12)).toBe("Skipped 12 topics");
    expect(decisionToastTitle("accept", 1)).toBe("Accepted suggestions for 1 topic");
  });

  it("moves focus to the next surviving row, or the previous one at the end", () => {
    const order = ["a", "b", "c", "d"];
    expect(focusAfterRemoval(order, new Set(["b"]), "b")).toBe("c");
    expect(focusAfterRemoval(order, new Set(["b", "c"]), "b")).toBe("d");
    expect(focusAfterRemoval(order, new Set(["d"]), "d")).toBe("c");
    expect(focusAfterRemoval(order, new Set(["a", "b", "c", "d"]), "a")).toBeNull();
    expect(focusAfterRemoval(order, new Set(["c"]), "a")).toBe("a");
  });

  it("falls back to the same index after a refetch and moves with j/k", () => {
    expect(reconcileFocus(["a", "c"], "b", 1)).toBe("c");
    expect(reconcileFocus(["a"], "b", 4)).toBe("a");
    expect(reconcileFocus([], "b", 0)).toBeNull();
    expect(moveFocus(["a", "b"], null, 1)).toBe("a");
    expect(moveFocus(["a", "b"], "b", 1)).toBe("b");
    expect(moveFocus(["a", "b"], "b", -1)).toBe("a");
  });

  it("enforces client port limits", () => {
    expect(portLimitError(0, "together")).toMatch(/at least one/u);
    expect(portLimitError(21, "together")).toMatch(/20/u);
    expect(portLimitError(6, "separately")).toMatch(/5 separate/u);
    expect(portLimitError(6, "together")).toBeNull();
  });

  it("records equivalent and blocked outcomes from a port thread", () => {
    expect(equivalentFromLink(link({ kind: "equivalent", detail: "src/a.ts:10, bad, src/b.ts:2" }, 42))).toEqual({
      kind: "equivalent",
      f5Refs: ["#42"],
      evidence: ["src/a.ts:10", "src/b.ts:2"],
    });
    expect(equivalentFromLink(link(null))).toEqual({ kind: "equivalent" });
    expect(watchFromBlocked(link({ kind: "blocked", detail: "needs the new API" }))).toEqual({
      kind: "watch",
      reason: "Blocked: needs the new API",
    });
    expect(watchFromBlocked(link({ kind: "pr", detail: "https://x" }))).toBeNull();
  });

  it("keeps the project's other overrides when saving upstream settings", () => {
    const triage = { instanceId: "claude", model: "claude-opus-5-5" } as never;
    const current = {
      schedule: { mode: "daily" as const, hour: 7, weekday: 1 },
      triageModelSelection: triage,
      portModelSelection: null,
    };
    const overrides = {
      defaultRuntimeMode: "approval-required" as const,
      enableAgentBrowserAccess: false,
      upstreamPorts: current,
    };
    expect(
      upstreamSettingsOverrides(overrides, current, { schedule: { ...current.schedule, hour: 9 } }),
    ).toEqual({
      defaultRuntimeMode: "approval-required",
      enableAgentBrowserAccess: false,
      upstreamPorts: { ...current, schedule: { mode: "daily", hour: 9, weekday: 1 } },
    });
  });

  it("batches bulk decisions at the server limit", () => {
    const ids = Array.from({ length: 450 }, (_, index) => `t${index}`);
    expect(decisionBatches(ids).map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(decisionBatches(ids).flat()).toEqual(ids);
    expect(decisionBatches([])).toEqual([]);
  });

  it("acts on visible selected topics, or the focused row when a filter hides them all", () => {
    const ids = ["a", "b", "c"];
    expect(actionTargets(ids, new Set(["c", "a"]), "b")).toEqual(["a", "c"]);
    expect(actionTargets(ids, new Set(["hidden"]), "b")).toEqual(["b"]);
    expect(actionTargets(ids, new Set(), "gone")).toEqual([]);
  });

  it("limits port prompts and ports to portable topics", () => {
    const rows = [
      { topic: { id: "a" }, state: "ready" },
      { topic: { id: "b" }, state: "inbox" },
      { topic: { id: "c" }, state: "in-progress" },
    ];
    expect(portableTopicIds(topicStates(rows, "inbox"), ["a", "b", "c", "unloaded"])).toEqual(["a", "c"]);
    // Topics past the loaded rows take the list's state ("Select all matching" stays within one list).
    expect(portableTopicIds(topicStates(rows, "ready"), ["b", "unloaded"])).toEqual(["unloaded"]);
    expect(topicCount(1)).toBe("1 topic");
    expect(topicCount(1204)).toBe(`${(1204).toLocaleString()} topics`);
    expect(unseenNote(1)).toMatch(/^1 topic is not loaded .* seen it\.$/u);
    expect(unseenNote(3)).toMatch(/^3 topics are not loaded .* seen them\.$/u);
    expect(promptLimitError(0)).toMatch(/at least one/u);
    expect(promptLimitError(20)).toBeNull();
    expect(promptLimitError(21)).toMatch(/20/u);
  });

  it("moves focus after a decision only if the user stayed on the same view", () => {
    const started = { projectId: "p", list: "inbox" as const, focused: "a" };
    expect(canMoveFocusAfterDecision(started, started)).toBe(true);
    expect(canMoveFocusAfterDecision(started, { ...started, list: "ready" })).toBe(false);
    expect(canMoveFocusAfterDecision(started, { ...started, projectId: "q" })).toBe(false);
    expect(canMoveFocusAfterDecision(started, { ...started, focused: "b" })).toBe(false);
  });

  it("preselects the suggested skip reason", () => {
    expect(
      preselectedSkipReason({
        suggestion: { status: "skip", reasonKey: "mobile", reason: "", userImpact: "none", confidence: 1, areas: [], model: "m" },
      }),
    ).toBe("mobile");
    expect(preselectedSkipReason({})).toBeNull();
  });
});
