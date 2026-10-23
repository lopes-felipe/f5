import type { UsageMetrics, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  cacheRateText,
  costDelta,
  formatDelta,
  resolveUsageTimeZone,
  tokenDelta,
  tokenFieldDisplay,
} from "./format";

describe("resolveUsageTimeZone", () => {
  it("keeps a valid zone and degrades an unknown or missing one to UTC", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
    try {
      resolvedOptions.mockReturnValue({ ...resolved, timeZone: "Europe/Helsinki" });
      expect(resolveUsageTimeZone()).toBe("Europe/Helsinki");
      resolvedOptions.mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });
      expect(resolveUsageTimeZone()).toBe("UTC");
      resolvedOptions.mockReturnValue({ ...resolved, timeZone: "" });
      expect(resolveUsageTimeZone()).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

function metrics(overrides: Partial<UsageMetrics> = {}): UsageMetrics {
  return {
    turnCount: 4,
    reportedTokenTurnCount: 4,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerReportedCostUsd: null,
    pricedTurnCount: 0,
    unpricedTurnCount: 4,
    reporting: {
      recordedTurnCount: 4,
      legacyCostEventCount: 0,
      inputTokenTurnCount: 4,
      outputTokenTurnCount: 4,
      cacheReadTokenTurnCount: 4,
      cacheWriteTokenTurnCount: 4,
      totalTokenTurnCount: 4,
    },
    ...overrides,
  };
}

const withReporting = (overrides: Partial<NonNullable<UsageMetrics["reporting"]>>) =>
  metrics({ reporting: { ...metrics().reporting!, ...overrides } });

describe("tokenFieldDisplay", () => {
  it("distinguishes unreported, reported zero, and partial values", () => {
    expect(tokenFieldDisplay(withReporting({ totalTokenTurnCount: 0 }), "totalTokens").value).toBe(
      "Unreported",
    );
    expect(tokenFieldDisplay(metrics(), "totalTokens")).toMatchObject({ value: "0", detail: null });
    expect(
      tokenFieldDisplay(
        { ...withReporting({ cacheReadTokenTurnCount: 1 }), cacheReadTokens: 40 },
        "cacheReadTokens",
      ),
    ).toMatchObject({ value: "40", detail: "1 of 4 recorded turns" });
  });

  it("shows cost-only legacy history as unreported, and empty history as zero", () => {
    const empty = withReporting({
      recordedTurnCount: 0,
      inputTokenTurnCount: 0,
      outputTokenTurnCount: 0,
      cacheReadTokenTurnCount: 0,
      cacheWriteTokenTurnCount: 0,
      totalTokenTurnCount: 0,
    });
    expect(tokenFieldDisplay(empty, "totalTokens").value).toBe("0");
    expect(
      tokenFieldDisplay(
        { ...empty, reporting: { ...empty.reporting!, legacyCostEventCount: 3 } },
        "totalTokens",
      ).value,
    ).toBe("Unreported");
  });

  it("never shows a confirmed zero for older servers with records", () => {
    expect(tokenFieldDisplay(metrics({ reporting: null }), "totalTokens")).toMatchObject({
      value: "Unknown",
      detail: "Field coverage unavailable",
    });
    expect(
      tokenFieldDisplay(metrics({ reporting: null, totalTokens: 12 }), "totalTokens"),
    ).toMatchObject({ value: "12", detail: "Field coverage unavailable" });
  });
});

describe("deltas and cache rate", () => {
  const summary = (current: UsageMetrics, previous: UsageMetrics | null): UsageSummary => ({
    range: "7d",
    timeZone: "UTC",
    generatedAt: "2026-10-15T12:00:00.000Z",
    metrics: current,
    buckets: [
      {
        key: "2026-10-15",
        label: "Oct 15",
        startAt: "2026-10-15T00:00:00.000Z",
        endAt: null,
        metrics: current,
        composition: {
          uncachedInputTokens: 30,
          outputTokens: 10,
          cacheReadTokens: 60,
          cacheWriteTokens: 10,
          unattributedTokens: 0,
        },
      },
    ],
    byProvider: [],
    coverage: {
      coverageStartedAt: "2026-01-01T00:00:00.000Z",
      rangeStartedAt: "2026-10-09T00:00:00.000Z",
      partialHistory: false,
      historicalCostTurnCount: 0,
      tokenUnreportedTurnCount: 0,
      costUnreportedTurnCount: 0,
      providersMissingTokens: [],
      providersMissingCost: [],
    },
    nextBucketAt: null,
    projectScope: null,
    previousMetrics: previous,
  });

  it("formats signed changes with a true minus sign and New", () => {
    expect(formatDelta(150, 100, "7 days")).toBe("+50% vs previous 7 days");
    expect(formatDelta(50, 100, "7 days")).toBe("−50% vs previous 7 days");
    expect(formatDelta(5, 0, "7 days")).toBe("New vs previous 7 days");
    expect(formatDelta(0, 0, "7 days")).toBeNull();
  });

  it("hides deltas without comparable data", () => {
    const current = metrics({ totalTokens: 150, providerReportedCostUsd: 2, pricedTurnCount: 1 });
    const previous = metrics({ totalTokens: 100, providerReportedCostUsd: 1, pricedTurnCount: 1 });
    expect(tokenDelta(summary(current, previous))).toBe("+50% vs previous 7 days");
    expect(costDelta(summary(current, previous))).toBe("+100% vs previous 7 days");
    expect(tokenDelta(summary(current, null))).toBeNull();
    expect(
      tokenDelta(
        summary(
          { ...current, reporting: withReporting({ totalTokenTurnCount: 3 }).reporting },
          previous,
        ),
      ),
    ).toBeNull();
    expect(costDelta(summary(current, { ...previous, pricedTurnCount: 0 }))).toBeNull();
  });

  it("computes cache rate over known composition with a coverage qualifier", () => {
    expect(cacheRateText(summary(metrics(), null))).toBe("60% of input served from cache");
    expect(cacheRateText(summary(withReporting({ totalTokenTurnCount: 2 }), null))).toBe(
      "60% of input served from cache · 2 of 4 recorded turns",
    );
    // Complete totals but partial cache-read coverage still qualify the rate.
    expect(cacheRateText(summary(withReporting({ cacheReadTokenTurnCount: 1 }), null))).toBe(
      "60% of input served from cache · 1 of 4 recorded turns",
    );
    expect(cacheRateText(summary(withReporting({ cacheReadTokenTurnCount: 0 }), null))).toBeNull();
  });
});
