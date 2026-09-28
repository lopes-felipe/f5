import { describe, expect, it } from "vitest";
import { claudeLimitState, usageLimitMessage } from "./usageLimitMessages.ts";
import { formatCodexUsageError, mergeCodexLimitSnapshot } from "./codexErrors.ts";

describe("provider usage-limit messages", () => {
  const reset = Date.parse("2026-09-29T12:00:00Z") / 1000;
  it("names Claude's rejected window and reset", () => {
    const state = claudeLimitState({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: reset,
    });
    expect(state.blocked).toBe(true);
    expect(state.message).toContain("5-hour");
    expect(state.message).toContain("2026-09-29T12:00:00.000Z");
  });
  it.each(["allowed", "allowed_warning"])("does not block %s overage", (overageStatus) => {
    expect(claudeLimitState({ status: "rejected", overageStatus }).blocked).toBe(false);
  });
  it("clears a rejection when the same window becomes allowed", () => {
    expect(claudeLimitState({ status: "allowed", rateLimitType: "five_hour" })).toMatchObject({
      blocked: false,
      window: "five_hour",
    });
  });
  it.each([null, NaN, Infinity, -1, 1e30])("omits an invalid reset (%s)", (reset) => {
    expect(usageLimitMessage("Claude", undefined, reset)).not.toContain("Resets at");
  });
  it("keeps the main Codex allowance when Spark emits a separate update", () => {
    const original = { primary: { usedPercent: 100, resetsAt: reset, windowDurationMins: 300 } };
    expect(
      mergeCodexLimitSnapshot(original, { limitId: "codex_other", primary: { usedPercent: 1 } }),
    ).toBe(original);
    const merged = mergeCodexLimitSnapshot(original, {
      secondary: { usedPercent: 0 },
    });
    expect(merged?.primary).toEqual(original.primary);
    expect(formatCodexUsageError("out of credits", merged, "2026-09-28T00:00:00Z")).toContain(
      "5-hour usage limit",
    );
  });
  it("names the longer blocking Codex window and leaves unrelated errors intact", () => {
    expect(
      formatCodexUsageError(
        "usage limit reached",
        {
          primary: { usedPercent: 100, resetsAt: reset, windowDurationMins: 300 },
          secondary: { usedPercent: 100, resetsAt: reset + 86400, windowDurationMins: 10080 },
        },
        "2026-09-28T00:00:00Z",
      ),
    ).toContain("weekly");
    expect(formatCodexUsageError("connection reset", undefined, "2026-09-28T00:00:00Z")).toBe(
      "connection reset",
    );
  });
  it("recognizes typed Codex usage failures without matching English text", () => {
    expect(
      formatCodexUsageError(
        "Account unavailable",
        undefined,
        "2026-09-28T00:00:00Z",
        "usageLimitReached",
      ),
    ).toContain("Codex usage limit reached");
  });
});
