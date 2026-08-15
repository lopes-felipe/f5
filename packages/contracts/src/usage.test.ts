import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { UsageGetSummaryInput, UsageSummary } from "./usage";

describe("usage contracts", () => {
  it("decodes bounded summary requests", () => {
    expect(
      Schema.decodeUnknownSync(UsageGetSummaryInput)({ range: "30d", timeZone: "Europe/Berlin" }),
    ).toEqual({ range: "30d", timeZone: "Europe/Berlin" });
    expect(() =>
      Schema.decodeUnknownSync(UsageGetSummaryInput)({ range: "all", timeZone: "UTC" }),
    ).toThrow();
  });

  it("preserves unreported monetary values as null", () => {
    const decoded = Schema.decodeUnknownSync(UsageSummary)({
      range: "24h",
      timeZone: "UTC",
      generatedAt: "2026-08-15T12:00:00.000Z",
      metrics: {
        turnCount: 1,
        reportedTokenTurnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        providerReportedCostUsd: null,
        pricedTurnCount: 0,
        unpricedTurnCount: 1,
      },
      buckets: [],
      byProvider: [],
      coverage: {
        coverageStartedAt: "2026-08-15T00:00:00.000Z",
        rangeStartedAt: "2026-08-14T12:00:00.000Z",
        partialHistory: true,
        historicalCostTurnCount: 0,
        tokenUnreportedTurnCount: 1,
        costUnreportedTurnCount: 1,
        providersMissingTokens: ["cursor"],
        providersMissingCost: ["cursor"],
      },
    });

    expect(decoded.metrics.providerReportedCostUsd).toBeNull();
    expect(decoded.coverage.costUnreportedTurnCount).toBe(1);
  });
});
