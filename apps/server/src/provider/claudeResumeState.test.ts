import { describe, expect, it } from "vitest";
import { readClaudeResumeState } from "./claudeResumeState.ts";

describe("Claude resume cost baseline", () => {
  it.each([0, 0.123456789, 4.85])("preserves the unrounded total %s", (lastTotalCostUsd) => {
    expect(readClaudeResumeState({ lastTotalCostUsd })?.lastTotalCostUsd).toBe(lastTotalCostUsd);
  });
  it.each([undefined, null, "0.3", -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid or missing totals: %s",
    (lastTotalCostUsd) => {
      expect(readClaudeResumeState({ lastTotalCostUsd })).not.toHaveProperty("lastTotalCostUsd");
    },
  );
});
