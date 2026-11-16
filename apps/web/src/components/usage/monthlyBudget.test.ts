import type { UsageBucket, UsageMetrics } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  budgetMeters,
  hasBudget,
  monthToDateUsage,
  monthWindow,
  zonedMidnightMs,
} from "./monthlyBudget";

const metrics = (tokens: number, cost: number | null, unpriced = 0): UsageMetrics => ({
  turnCount: 1,
  reportedTokenTurnCount: 1,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: tokens,
  providerReportedCostUsd: cost,
  pricedTurnCount: cost === null ? 0 : 1,
  unpricedTurnCount: unpriced,
  reporting: null,
});

const bucket = (key: string, tokens: number, cost: number | null, unpriced = 0): UsageBucket => ({
  key,
  label: key,
  startAt: `${key}T00:00:00.000Z`,
  endAt: null,
  metrics: metrics(tokens, cost, unpriced),
  composition: null,
});

describe("monthWindow", () => {
  it("spans local midnight on the 1st to the next month in the zone", () => {
    const window = monthWindow(Date.parse("2026-11-08T12:00:00Z"), "America/New_York");
    expect(new Date(window.startMs).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    // November 1st 2026 is after the DST change, so December starts at UTC-5.
    expect(new Date(window.endMs).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(window.startKey).toBe("2026-11-01");
    expect(window.endKey).toBe("2026-12-01");
    expect(window.daysInMonth).toBe(30);
  });

  it("uses the zone's month at a UTC boundary and handles December", () => {
    const window = monthWindow(Date.parse("2027-01-01T02:00:00Z"), "America/Los_Angeles");
    expect(window.startKey).toBe("2026-12-01");
    expect(window.endKey).toBe("2027-01-01");
    expect(window.daysInMonth).toBe(31);
  });

  it("finds local midnight across a DST change", () => {
    expect(new Date(zonedMidnightMs(2026, 3, 8, "America/New_York")).toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(new Date(zonedMidnightMs(2026, 3, 9, "America/New_York")).toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });
});

describe("monthToDateUsage", () => {
  const buckets = [
    bucket("2026-10-31", 1_000, 5),
    bucket("2026-11-01", 100, 1),
    bucket("2026-11-02", 300, null, 2),
  ];

  it("sums only the current month and skips unknown cost", () => {
    const usage = monthToDateUsage({
      buckets,
      timeZone: "UTC",
      nowMs: Date.parse("2026-11-03T00:00:00Z"),
    });
    expect(usage.tokens).toBe(400);
    expect(usage.costUsd).toBe(1);
    expect(usage.unpricedTurnCount).toBe(2);
    expect(usage.elapsedFraction).toBeCloseTo(2 / 30);
    expect(usage.canForecast).toBe(true);
  });

  it("does not forecast in the first hour of the month", () => {
    const usage = monthToDateUsage({
      buckets,
      timeZone: "UTC",
      nowMs: Date.parse("2026-11-01T00:30:00Z"),
    });
    expect(usage.canForecast).toBe(false);
    const [meter] = budgetMeters({ costUsd: 10, tokens: null }, usage);
    expect(meter!.forecast).toBeNull();
    expect(meter!.forecastOver).toBe(false);
  });

  it("covers the 31st day of a long month", () => {
    const usage = monthToDateUsage({
      buckets: [bucket("2026-12-31", 50, 0.5)],
      timeZone: "UTC",
      nowMs: Date.parse("2026-12-31T12:00:00Z"),
    });
    expect(usage.tokens).toBe(50);
    expect(usage.elapsedFraction).toBeCloseTo(30.5 / 31);
  });
});

describe("budgetMeters", () => {
  const usage = monthToDateUsage({
    buckets: [bucket("2026-11-01", 1_000, 40)],
    timeZone: "UTC",
    // 6 of 30 days elapsed.
    nowMs: Date.parse("2026-11-07T00:00:00Z"),
  });

  it("forecasts linearly and finds when the pace crosses the budget", () => {
    const [cost] = budgetMeters({ costUsd: 100, tokens: null }, usage);
    expect(cost!.forecast).toBeCloseTo(200);
    expect(cost!.forecastOver).toBe(true);
    expect(cost!.exceeded).toBe(false);
    expect(cost!.warn).toBe(true);
    // $40 in 6 days reaches $100 after 15 days.
    expect(new Date(cost!.exceedsAtMs!).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });

  it("marks an exceeded budget and keeps under-pace budgets quiet", () => {
    const [cost, tokens] = budgetMeters({ costUsd: 20, tokens: 1_000_000 }, usage);
    expect(cost!.exceeded).toBe(true);
    expect(cost!.forecastOver).toBe(false);
    expect(tokens!.kind).toBe("tokens");
    expect(tokens!.warn).toBe(false);
  });

  it("ignores missing and zero budgets", () => {
    expect(budgetMeters(null, usage)).toEqual([]);
    expect(budgetMeters({ costUsd: 0, tokens: null }, usage)).toEqual([]);
    expect(hasBudget({ costUsd: null, tokens: null })).toBe(false);
    expect(hasBudget({ costUsd: null, tokens: 5 })).toBe(true);
  });
});
