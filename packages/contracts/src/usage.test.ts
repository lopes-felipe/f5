import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ClaudeAccountUsage,
  UsageConsumeResetCreditInput,
  UsageConsumeResetCreditResult,
  UsageGetSummaryInput,
  UsageSummary,
} from "./usage";

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
    expect(decoded).not.toHaveProperty("codexAccount");
  });

  it("ignores the retired embedded account field from older servers", () => {
    const decoded = Schema.decodeUnknownSync(UsageSummary)({
      range: "7d",
      timeZone: "UTC",
      generatedAt: "2026-08-18T12:00:00.000Z",
      metrics: {
        turnCount: 0,
        reportedTokenTurnCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        providerReportedCostUsd: null,
        pricedTurnCount: 0,
        unpricedTurnCount: 0,
      },
      buckets: [],
      byProvider: [],
      coverage: {
        coverageStartedAt: "2026-08-18T00:00:00.000Z",
        rangeStartedAt: "2026-08-12T00:00:00.000Z",
        partialHistory: false,
        historicalCostTurnCount: 0,
        tokenUnreportedTurnCount: 0,
        costUnreportedTurnCount: 0,
        providersMissingTokens: [],
        providersMissingCost: [],
      },
      codexAccount: {
        status: "available",
        fetchedAt: "2026-08-18T12:00:00.000Z",
        tokenSummary: {
          lifetimeTokens: "123456",
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: "2",
          longestStreakDays: "5",
        },
        dailyUsageBuckets: [],
        rateLimits: [],
        message: null,
      },
    });

    expect(decoded).not.toHaveProperty("codexAccount");
    expect(decoded.metrics.providerReportedCostUsd).toBeNull();
  });
  it("decodes Claude snapshots stored before limit resets", () => {
    const stored = {
      subscriptionLabel: "Max",
      limitsAvailable: true,
      windows: [],
      extraUsage: null,
    };
    expect(Schema.decodeUnknownSync(ClaudeAccountUsage)(stored)).toEqual(stored);
    const grant = {
      id: "full_2026_11",
      label: "Full reset",
      kind: "full",
      resetsLeft: 1,
      resetsTotal: 1,
      endsAt: "2026-12-10T22:00:00.000Z",
      usableNow: true,
      useRequiresLimit: false,
      givesBackWeekly: false,
      paused: false,
      clears: ["five_hour"],
      blocking: [],
      unavailableReason: null,
    };
    const current = {
      ...stored,
      limitResets: { grants: [grant], nextGrantId: grant.id, cooldownUntil: null },
    };
    expect(Schema.decodeUnknownSync(ClaudeAccountUsage)(current)).toEqual(current);
  });

  it("accepts Claude grant ids and the unavailable outcome", () => {
    const input = { providerInstanceId: "claude", idempotencyKey: "key", grantId: "fable" };
    expect(Schema.decodeUnknownSync(UsageConsumeResetCreditInput)(input)).toEqual(input);
    expect(() =>
      Schema.decodeUnknownSync(UsageConsumeResetCreditInput)({ ...input, grantId: "Bad Id" }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(UsageConsumeResetCreditResult)({
        outcome: "unavailable",
        message: "Paused",
      }),
    ).toEqual({ outcome: "unavailable", message: "Paused" });
    expect(Schema.decodeUnknownSync(UsageConsumeResetCreditResult)({ outcome: "reset" })).toEqual({
      outcome: "reset",
    });
  });
});
