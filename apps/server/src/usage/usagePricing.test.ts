import { describe, expect, it, vi } from "vitest";
import type { UsageAggregateRow } from "../persistence/Services/UsageFacts.ts";
import { parseRateTable } from "./modelRateTable.ts";
import { makeListRateCache, priceUsageAggregate } from "./usagePricing.ts";
import { aggregateUsageMetrics } from "./usageSummary.ts";

const ratesDocument = {
  "openai/test-model": {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000004,
    cache_read_input_token_cost: 0.000001,
    input_cost_per_token_priority: 0.000004,
    output_cost_per_token_priority: 0.000008,
  },
};

const usage: UsageAggregateRow = {
  provider: "codex",
  model: "test-model",
  speed: "fast",
  turnCount: 1,
  reportedTokenTurnCount: 1,
  inputTokens: 1_000_000,
  cacheReadTokens: 250_000,
  cacheWriteTokens: 0,
  outputTokens: 500_000,
  totalTokens: 1_500_000,
  providerReportedCostUsd: null,
  pricedTurnCount: 0,
  unpricedTurnCount: 1,
  recordedTurnCount: 1,
  legacyCostEventCount: 0,
  inputTokenTurnCount: 1,
  outputTokenTurnCount: 1,
  cacheReadTokenTurnCount: 1,
  cacheWriteTokenTurnCount: 1,
  totalTokenTurnCount: 1,
};

describe("usage pricing", () => {
  it("prices fast rates and separates cached input from standard input", () => {
    const priced = priceUsageAggregate(usage, undefined, parseRateTable(ratesDocument));
    expect(priced.estimatedCostUsd).toBeCloseTo(7.5);
    expect(priced.costBreakdown?.byType).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0.5,
      cacheWrite: 0,
      unattributed: 0,
    });
    expect(priced.costBreakdown?.bySpeed.fast).toBe(7.5);
    expect(priced.costBreakdown?.speedPremiumUsd).toBe(3.75);
  });

  it("keeps reported cost and reconciles legacy unknown attribution", () => {
    const table = parseRateTable(ratesDocument);
    const reported = priceUsageAggregate(
      {
        ...usage,
        providerReportedCostUsd: 15,
        pricedTurnCount: 1,
        unpricedTurnCount: 0,
      },
      undefined,
      table,
    );
    const legacy = priceUsageAggregate(
      {
        ...usage,
        model: null,
        speed: null,
        providerReportedCostUsd: 2,
        pricedTurnCount: 1,
      },
      undefined,
      table,
    );
    const metrics = aggregateUsageMetrics([reported, legacy]);
    expect(metrics.providerReportedCostUsd).toBe(17);
    expect(metrics.estimatedCostUsd).toBeUndefined();
    expect(metrics.costBreakdown?.byType).toMatchObject({
      input: 6,
      output: 8,
      cacheRead: 1,
      unattributed: 2,
    });
    expect(metrics.costBreakdown?.bySpeed).toMatchObject({ fast: 15, unknown: 2 });
  });

  it("shares list-rate refreshes and retains the last good rates after failure", async () => {
    const fetchRates = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ratesDocument))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const load = makeListRateCache(fetchRates);
    const [first, second] = await Promise.all([load(1), load(1)]);
    expect(first).toBe(second);
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(await load(86_400_001)).toBe(first);
    expect(await load(86_400_002)).toBe(first);
    expect(fetchRates).toHaveBeenCalledTimes(2);
  });
});
