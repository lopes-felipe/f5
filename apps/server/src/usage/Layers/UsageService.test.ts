import { assert, describe, it } from "vitest";

import type { HourlyUsageFactSummary } from "../../persistence/Services/UsageFacts.ts";
import { buildUsageSummary, resolveUsageRangeWindow } from "./UsageService.ts";

function row(
  input: Partial<HourlyUsageFactSummary> &
    Pick<HourlyUsageFactSummary, "hourStartedAt" | "provider">,
): HourlyUsageFactSummary {
  return {
    model: null,
    turnCount: 1,
    reportedTokenTurnCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    totalTokens: 120,
    providerReportedCostUsd: null,
    pricedTurnCount: 0,
    unpricedTurnCount: 1,
    historicalCostTurnCount: 0,
    ...input,
  };
}

describe("usage summary", () => {
  it("uses local calendar boundaries across daylight-saving changes", () => {
    const window = resolveUsageRangeWindow({
      range: "7d",
      timeZone: "Europe/Berlin",
      now: new Date("2026-03-31T12:00:00.000Z"),
    });

    assert.equal(window.startedAt, "2026-03-24T23:00:00.000Z");
    assert.equal(window.endedAt, "2026-03-31T12:00:00.001Z");
  });

  it("returns fixed buckets, provider breakdowns, and incomplete coverage diagnostics", () => {
    const summary = buildUsageSummary({
      request: { range: "7d", timeZone: "UTC" },
      now: new Date("2026-08-15T12:00:00.000Z"),
      coverageStartedAt: "2026-08-12T00:00:00.000Z",
      rangeStartedAt: "2026-08-09T00:00:00.000Z",
      rows: [
        row({ hourStartedAt: "2026-08-14T10:00:00.000Z", provider: "codex" }),
        row({
          hourStartedAt: "2026-08-14T11:00:00.000Z",
          provider: "claudeAgent",
          model: "claude-opus",
          reportedTokenTurnCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          providerReportedCostUsd: 0.4,
          pricedTurnCount: 1,
          unpricedTurnCount: 0,
          historicalCostTurnCount: 1,
        }),
      ],
    });

    assert.equal(summary.buckets.length, 7);
    assert.equal(summary.metrics.turnCount, 2);
    assert.equal(summary.metrics.totalTokens, 120);
    assert.equal(summary.metrics.providerReportedCostUsd, 0.4);
    assert.equal(summary.coverage.partialHistory, true);
    assert.equal(summary.coverage.historicalCostTurnCount, 1);
    assert.deepStrictEqual(summary.coverage.providersMissingTokens, ["claudeAgent"]);
    assert.deepStrictEqual(summary.coverage.providersMissingCost, ["codex"]);
    assert.equal(summary.byProvider.length, 2);
  });
});
