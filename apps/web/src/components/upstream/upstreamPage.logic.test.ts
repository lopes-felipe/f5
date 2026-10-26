import { describe, expect, it } from "vitest";

import {
  actionTargets,
  canMoveFocusAfterDecision,
  decisionBatches,
  equivalentFromLink,
  focusAfterRemoval,
  moveFocus,
  portableTopicIds,
  portLimitError,
  preselectedSkipReason,
  promptLimitError,
  reconcileFocus,
  suggestionChipLabel,
  upstreamSettingsOverrides,
  watchFromBlocked,
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
  it("formats suggestion chips", () => {
    const base = { reason: "", userImpact: "medium", areas: [], model: "m" } as const;
    expect(suggestionChipLabel({ ...base, status: "port", confidence: 0.92 })).toBe("Port 0.92");
    expect(suggestionChipLabel({ ...base, status: "skip", reasonKey: "mobile", confidence: 0.97 })).toBe("Skip: mobile 0.97");
    expect(suggestionChipLabel({ ...base, status: "equivalent", confidence: 0.7 })).toBe("Equivalent 0.70");
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
    expect(portableTopicIds(rows, ["a", "b", "c"])).toEqual(["a", "c"]);
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
