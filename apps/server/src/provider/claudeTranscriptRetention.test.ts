import { describe, expect, it } from "vitest";
import { resolveClaudeCleanupPeriodDays } from "./claudeTranscriptRetention.ts";

describe("Claude transcript retention", () => {
  it("keeps transcripts for ten years by default", () =>
    expect(resolveClaudeCleanupPeriodDays(undefined, {})).toBe(3650));
  it("respects a server setting and prefers explicit instance settings", () => {
    expect(resolveClaudeCleanupPeriodDays({}, { F5_CLAUDE_CLEANUP_PERIOD_DAYS: "90" })).toBe(90);
    expect(
      resolveClaudeCleanupPeriodDays(
        { cleanupPeriodDays: 7000 },
        { F5_CLAUDE_CLEANUP_PERIOD_DAYS: "90" },
      ),
    ).toBe(7000);
  });
  it.each([0, -1, 1.5, "0", "", "-1", null, NaN])(
    "rejects invalid operator value %s",
    (cleanupPeriodDays) => {
      expect(() => resolveClaudeCleanupPeriodDays({ cleanupPeriodDays }, {})).toThrow(
        "integer >= 1",
      );
    },
  );
});
