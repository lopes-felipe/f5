import "../../index.css";

import type { UsageMetrics, UsageSummary } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { UsageDashboardView } from "./UsageDashboard";

function metrics(overrides: Partial<UsageMetrics> = {}): UsageMetrics {
  return {
    turnCount: 2,
    reportedTokenTurnCount: 1,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 600,
    cacheWriteTokens: 50,
    totalTokens: 1_200,
    providerReportedCostUsd: 0.42,
    pricedTurnCount: 1,
    unpricedTurnCount: 1,
    ...overrides,
  };
}

function summary(): UsageSummary {
  return {
    range: "7d",
    timeZone: "UTC",
    generatedAt: "2026-08-15T12:00:00.000Z",
    codexAccount: {
      status: "available",
      fetchedAt: "2026-08-15T12:00:00.000Z",
      tokenSummary: {
        lifetimeTokens: "1250000",
        peakDailyTokens: "92000",
        longestRunningTurnSec: "480",
        currentStreakDays: "3",
        longestStreakDays: "8",
      },
      dailyUsageBuckets: [
        { startDate: "2026-08-14", tokens: "30000" },
        { startDate: "2026-08-15", tokens: "40000" },
      ],
      rateLimits: [
        {
          id: "codex",
          name: "Codex",
          planType: "plus",
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_787_000_000 },
          secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_787_500_000 },
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        },
      ],
      message: null,
    },
    metrics: metrics(),
    buckets: [
      {
        key: "2026-08-14",
        label: "Aug 14",
        startAt: "2026-08-14T00:00:00.000Z",
        metrics: metrics({ turnCount: 1, totalTokens: 400 }),
      },
      {
        key: "2026-08-15",
        label: "Aug 15",
        startAt: "2026-08-15T00:00:00.000Z",
        metrics: metrics({ turnCount: 1, totalTokens: 800 }),
      },
    ],
    byProvider: [
      { provider: "codex", model: "gpt-5.6", metrics: metrics() },
      {
        provider: "cursor",
        model: "cursor-agent",
        metrics: metrics({
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
        }),
      },
    ],
    coverage: {
      coverageStartedAt: "2026-08-12T00:00:00.000Z",
      rangeStartedAt: "2026-08-09T00:00:00.000Z",
      partialHistory: true,
      historicalCostTurnCount: 1,
      tokenUnreportedTurnCount: 1,
      costUnreportedTurnCount: 1,
      providersMissingTokens: ["cursor"],
      providersMissingCost: ["cursor"],
    },
  };
}

describe("UsageDashboardView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("labels provider-reported values and keeps missing values unreported", async () => {
    const onRangeChange = vi.fn();
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
        range="7d"
        onRangeChange={onRangeChange}
        fetching={false}
      />,
    );

    try {
      await expect
        .element(
          page.getByText(
            "Historical provider-reported tokens and API-equivalent cost, plus Codex account usage and limits. Subscription or invoice spend may differ.",
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("img", { name: "Token usage chart for 7 days" }))
        .toBeVisible();
      await expect
        .element(page.getByText("$0.42 + unreported", { exact: true }).first())
        .toBeVisible();
      await expect.element(page.getByText("Unreported", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText(/no price was estimated/i)).toBeVisible();
      await expect.element(page.getByText("Codex account usage", { exact: true })).toBeVisible();
      await expect.element(page.getByText("1.3M", { exact: true })).toBeVisible();
      await expect.element(page.getByText("70K", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("progressbar", { name: "5-hour limit" })).toBeVisible();

      await page.getByRole("button", { name: "30 days" }).click();
      expect(onRangeChange).toHaveBeenCalledWith("30d");
    } finally {
      await screen.unmount();
    }
  });
});
