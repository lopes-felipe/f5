import { describe, expect, it } from "vitest";

import {
  contextMeterTone,
  contextUsageSummaryLine,
  resolveContextUsage,
} from "./contextMeter.logic";

describe("contextMeterTone", () => {
  it("stays muted below three quarters", () => {
    expect(contextMeterTone(0)).toBe("muted");
    expect(contextMeterTone(0.749)).toBe("muted");
  });

  it("warns from 75% and turns destructive from 90%", () => {
    expect(contextMeterTone(0.75)).toBe("warning");
    expect(contextMeterTone(0.899)).toBe("warning");
    expect(contextMeterTone(0.9)).toBe("destructive");
    expect(contextMeterTone(1.4)).toBe("destructive");
  });

  it("treats a non-finite ratio as muted", () => {
    expect(contextMeterTone(Number.NaN)).toBe("muted");
  });
});

describe("context usage summaries", () => {
  const base = {
    estimatedThinkingTokens: null,
    model: "gpt-5.4",
    provider: "codex" as const,
  };

  it("formats used tokens against the model window", () => {
    expect(
      resolveContextUsage({
        ...base,
        estimatedContextTokens: 38_000,
        modelContextWindowTokens: 200_000,
      })?.label,
    ).toBe("38K / 200K (19%)");
  });

  it("joins context and thinking into one compact-menu line", () => {
    expect(
      contextUsageSummaryLine({
        ...base,
        estimatedContextTokens: 38_000,
        modelContextWindowTokens: 200_000,
        estimatedThinkingTokens: 12_500,
      }),
    ).toBe("Context 38K / 200K (19%) · 12.5K thinking");
    expect(
      contextUsageSummaryLine({
        ...base,
        estimatedContextTokens: null,
        modelContextWindowTokens: null,
      }),
    ).toBeNull();
  });
});
