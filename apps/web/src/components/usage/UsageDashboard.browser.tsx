import "../../index.css";

import type { UsageMetrics, UsageSummary, UsageAccounts } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import {
  decodeUsageSummary,
  usageAccountsQueryOptions,
  usageQueryKeys,
} from "../../lib/usageReactQuery";
import { UsageDashboard, UsageDashboardView } from "./UsageDashboard";

const api = vi.hoisted(() => ({ getSummary: vi.fn(), getAccounts: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ usage: api }) }));

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

const codex = {
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
};
function accounts(): UsageAccounts {
  return [
    {
      key: "codex:default",
      provider: "codex",
      providerInstanceId: null,
      displayName: "Codex — default configuration",
      enabled: true,
      refreshState: "idle",
      sections: [
        {
          kind: "codex-tokens",
          outcome: "available",
          lastAttemptAt: codex.fetchedAt,
          errorCode: null,
          snapshot: {
            fetchedAt: codex.fetchedAt,
            data: { tokenSummary: codex.tokenSummary, dailyUsageBuckets: codex.dailyUsageBuckets },
          },
        },
        {
          kind: "codex-limits",
          outcome: "available",
          lastAttemptAt: codex.fetchedAt,
          errorCode: null,
          snapshot: { fetchedAt: codex.fetchedAt, data: { rateLimits: codex.rateLimits } },
        },
      ],
    },
  ];
}

function summary(): UsageSummary {
  return {
    range: "7d",
    timeZone: "UTC",
    generatedAt: "2026-08-15T12:00:00.000Z",
    metrics: metrics(),
    buckets: [
      {
        key: "2026-08-14",
        label: "Aug 14",
        composition: null,
        startAt: "2026-08-14T00:00:00.000Z",
        metrics: metrics({ turnCount: 1, totalTokens: 400 }),
      },
      {
        key: "2026-08-15",
        label: "Aug 15",
        composition: null,
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
        accounts={accounts()}
        range="7d"
        onRangeChange={onRangeChange}
        fetching={false}
      />,
    );

    try {
      await expect
        .element(
          page.getByText(
            "Historical provider-reported tokens and API-equivalent cost, plus account usage and limits. Subscription or invoice spend may differ.",
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("img", { name: "Token usage chart for 7 days (UTC)" }))
        .toBeVisible();
      await expect
        .element(page.getByText("$0.42 + unreported", { exact: true }).first())
        .toBeVisible();
      await expect.element(page.getByText("Unreported", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText(/no price was estimated/i)).toBeVisible();
      await expect
        .element(page.getByText("Codex — default configuration", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("1.3M", { exact: true })).toBeVisible();
      await expect.element(page.getByText("70K", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Codex · 5-hour limit" }))
        .toBeVisible();

      await page.getByRole("button", { name: "30 days" }).click();
      expect(onRangeChange).toHaveBeenCalledWith("30d");
    } finally {
      await screen.unmount();
    }
  });
});

describe("query-connected usage dashboard", () => {
  afterEach(() => {
    vi.resetAllMocks();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });
  it("keeps successful history visible after a rejected refresh and catches account rejection", async () => {
    api.getSummary.mockResolvedValueOnce(summary()).mockRejectedValue(new Error("offline"));
    api.getAccounts.mockResolvedValueOnce(accounts()).mockRejectedValue(new Error("offline"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await page.getByRole("button", { name: "Refresh usage" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Usage refresh failed");
      await expect.element(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("heading", { name: "Usage is unavailable" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Dismiss refresh error" }).click();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      expect(api.getAccounts).toHaveBeenLastCalledWith({ refresh: "force" });
    } finally {
      await screen.unmount();
      client.clear();
    }
  });
  it("polls only memory while jobs run, disables duplicate refresh, and leaves accounts independent of range", async () => {
    const running = accounts().map((a) => ({ ...a, refreshState: "refreshing" as const }));
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts
      .mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(running)
      .mockResolvedValue(accounts());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await page.getByRole("button", { name: "Refresh usage" }).click();
      await expect.element(page.getByRole("button", { name: "Refresh usage" })).toBeDisabled();
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(3);
      expect(api.getAccounts.mock.calls.map((call) => call[0])).toEqual([
        { refresh: "if-stale" },
        { refresh: "force" },
        { refresh: "none" },
      ]);
      await expect.element(page.getByRole("button", { name: "Refresh usage" })).toBeEnabled();
      await page.getByRole("button", { name: "30 days" }).click();
      expect(api.getAccounts).toHaveBeenCalledTimes(3);
      expect(usageAccountsQueryOptions().refetchIntervalInBackground).toBe(false);
    } finally {
      await screen.unmount();
      client.clear();
    }
  });
  it("refreshes stale accounts on focus and reconnect without background polling", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={client}>
        <UsageDashboard />
      </QueryClientProvider>,
    );
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      client.setQueryData(usageQueryKeys.accounts, accounts(), { updatedAt: Date.now() - 301_000 });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(2);
      client.setQueryData(usageQueryKeys.accounts, accounts(), { updatedAt: Date.now() - 301_000 });
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(3);
    } finally {
      await screen.unmount();
      client.clear();
    }
  });
});

it("decodes an entire older summary and renders its nonzero fallback bars", async () => {
  const old = {
    ...summary(),
    buckets: summary().buckets.map(({ composition: _composition, ...bucket }) => bucket),
  };
  const decoded = decodeUsageSummary(old);
  expect(decoded.buckets[0]?.composition).toBeNull();
  const screen = await render(
    <UsageDashboardView summary={decoded} range="7d" onRangeChange={() => {}} fetching={false} />,
  );
  try {
    await expect
      .element(page.getByRole("img", { name: "Token usage chart for 7 days (UTC)" }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("renders Claude unknown and zero meters distinctly alongside Codex, with neutral limit states", async () => {
  await page.viewport(1280, 2100);
  const claude: UsageAccounts[number] = {
    key: "claude:test",
    provider: "claudeAgent",
    providerInstanceId: null,
    displayName: "Claude",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        kind: "claude-usage",
        outcome: "available",
        lastAttemptAt: codex.fetchedAt,
        errorCode: null,
        snapshot: {
          fetchedAt: codex.fetchedAt,
          data: {
            subscriptionLabel: "Pro",
            limitsAvailable: true,
            windows: [
              { key: "five_hour", label: "5-hour limit", utilization: null, resetsAt: "bad date" },
              { key: "seven_day", label: "Weekly limit", utilization: 0, resetsAt: null },
            ],
            extraUsage: { enabled: false, utilization: null },
          },
        },
      },
    ],
  };
  const screen = await render(
    <UsageDashboardView
      summary={{
        ...summary(),
        buckets: summary().buckets.map((bucket, index) => ({
          ...bucket,
          composition: {
            uncachedInputTokens: 120 * (index + 1),
            outputTokens: 80 * (index + 1),
            cacheReadTokens: 160 * (index + 1),
            cacheWriteTokens: 40 * (index + 1),
            unattributedTokens: 0,
          },
        })),
      }}
      accounts={[...accounts(), claude]}
      range="7d"
      onRangeChange={() => {}}
      fetching={false}
    />,
  );
  try {
    await expect
      .element(page.getByRole("progressbar", { name: "Claude · 5-hour limit" }))
      .not.toHaveAttribute("aria-valuenow");
    await expect
      .element(page.getByRole("progressbar", { name: "Claude · Weekly limit" }))
      .toHaveAttribute("aria-valuenow", "0");
    await expect
      .element(page.getByRole("progressbar", { name: "Codex · 5-hour limit" }))
      .toBeVisible();
    await expect.element(page.getByText("Unknown", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it.each([
  ["disabled", "Claude is disabled in provider settings."],
  ["unsupported", "This installed Claude version does not expose account usage and rate limits."],
  ["unavailable", "The account usage request timed out."],
  ["no-limits", "Plan limits aren't reported for this Claude session."],
] as const)("confines the %s state to its Claude card", async (state, message) => {
  const fetchedAt = "2026-09-05T00:00:00Z";
  const account: UsageAccounts[number] = {
    key: "claude:state",
    provider: "claudeAgent",
    providerInstanceId: null,
    displayName: "Claude",
    enabled: state !== "disabled",
    refreshState: "idle",
    sections: [
      {
        kind: "claude-usage",
        outcome:
          state === "unsupported"
            ? "unsupported"
            : state === "unavailable"
              ? "unavailable"
              : "available",
        lastAttemptAt: fetchedAt,
        errorCode: state === "unavailable" ? "timeout" : null,
        snapshot:
          state === "no-limits" || state === "unavailable"
            ? {
                fetchedAt,
                data: {
                  subscriptionLabel: null,
                  limitsAvailable: false,
                  windows: [],
                  extraUsage: null,
                },
              }
            : null,
      },
    ],
  };
  const screen = await render(
    <UsageDashboardView
      summary={summary()}
      accounts={[account]}
      range="7d"
      onRangeChange={() => {}}
      fetching={false}
    />,
  );
  try {
    await expect.element(page.getByText(message, { exact: state !== "unavailable" })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
    if (state === "unavailable")
      await expect.element(page.getByText(/Showing data from/)).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("gives a zero bucket no visible bar and uses the Codex snapshot's UTC clock", async () => {
  const value = summary();
  const screen = await render(
    <UsageDashboardView
      summary={{
        ...value,
        generatedAt: "2026-09-05T12:00:00Z",
        buckets: value.buckets.map((bucket, index) =>
          index === 0 ? { ...bucket, metrics: metrics({ totalTokens: 0 }) } : bucket,
        ),
      }}
      accounts={accounts()}
      range="24h"
      onRangeChange={() => {}}
      fetching={false}
    />,
  );
  try {
    const chart = document.querySelector('[role="img"]');
    const zeroBar = chart?.querySelector<HTMLElement>('[style*="height: 0%"]');
    expect(zeroBar?.getBoundingClientRect().height).toBe(0);
    await expect.element(page.getByText("Account tokens \u00b7 Today (UTC)")).toBeVisible();
    await expect.element(page.getByText("40K", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
