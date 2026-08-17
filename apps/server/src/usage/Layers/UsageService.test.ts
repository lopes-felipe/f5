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

  it("resolves zones whose daylight-saving transition skips local midnight", () => {
    const window = resolveUsageRangeWindow({
      range: "7d",
      timeZone: "America/Havana",
      now: new Date("2026-03-14T12:00:00.000Z"),
    });
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Havana",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    const parts = new Map(
      local
        .formatToParts(new Date(window.startedAt))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value] as const),
    );
    assert.deepStrictEqual(
      {
        year: parts.get("year"),
        month: parts.get("month"),
        day: parts.get("day"),
        hour: parts.get("hour"),
      },
      { year: "2026", month: "03", day: "08", hour: "01" },
    );
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

  it("keeps summary totals equal to the visible bucket totals", () => {
    const summary = buildUsageSummary({
      request: { range: "24h", timeZone: "UTC" },
      now: new Date("2026-08-15T12:30:00.000Z"),
      coverageStartedAt: "2026-08-01T00:00:00.000Z",
      rangeStartedAt: "2026-08-14T13:00:00.000Z",
      rows: [
        row({ hourStartedAt: "2026-08-15T12:00:00.000Z", provider: "codex" }),
        row({ hourStartedAt: "2026-08-01T12:00:00.000Z", provider: "codex" }),
      ],
    });
    const bucketTurnCount = summary.buckets.reduce(
      (total, bucket) => total + bucket.metrics.turnCount,
      0,
    );
    assert.equal(summary.metrics.turnCount, bucketTurnCount);
    assert.equal(summary.metrics.turnCount, 1);
  });
});
