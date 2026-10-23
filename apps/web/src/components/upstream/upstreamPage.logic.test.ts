import { describe, expect, it } from "vitest";

import {
  equivalentFromLink,
  focusAfterRemoval,
  moveFocus,
  portLimitError,
  preselectedSkipReason,
  reconcileFocus,
  suggestionChipLabel,
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

  it("preselects the suggested skip reason", () => {
    expect(
      preselectedSkipReason({
        suggestion: { status: "skip", reasonKey: "mobile", reason: "", userImpact: "none", confidence: 1, areas: [], model: "m" },
      }),
    ).toBe("mobile");
    expect(preselectedSkipReason({})).toBeNull();
  });
});
