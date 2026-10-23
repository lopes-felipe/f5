import "../../index.css";

import {
  ProjectId,
  ProviderInstanceId,
  type ProviderKind,
  ThreadId,
  type UsageAccounts,
  type UsageBucket,
  type UsageMetrics,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  decodeUsageSummary,
  usageAccountsQueryOptions,
  usageQueryKeys,
} from "../../lib/usageReactQuery";
import { ResetCreditButton } from "./ResetCreditButton";
import { UsageDashboard, UsageDashboardView } from "./UsageDashboard";

const api = vi.hoisted(() => ({
  getSummary: vi.fn(),
  getAccounts: vi.fn(),
  getQuotaHistory: vi.fn(),
  consumeResetCredit: vi.fn(),
}));
const connection = vi.hoisted(() => ({
  state: {
    phase: "connected" as "connected" | "reconnecting",
    attemptCount: 1,
    connectedAt: "2026-08-15T00:00:00.000Z" as string | null,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  },
}));
const settings = vi.hoisted(() => ({
  current: {
    usagePriceOverrides: [] as Array<Record<string, unknown>>,
    usageModelAliases: {} as Record<string, string>,
  },
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: typeof settings.current) => unknown) => select(settings.current),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
const listeners = vi.hoisted(() => ({
  domain: new Set<(event: { type: string; payload?: unknown }) => void>(),
  storage: new Set<() => void>(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    usage: api,
    server: { getConfig: async () => ({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS }) },
    orchestration: {
      onDomainEvent: (listener: (event: { type: string; payload?: unknown }) => void) => {
        listeners.domain.add(listener);
        return () => listeners.domain.delete(listener);
      },
    },
    storage: {
      onInvalidated: (listener: () => void) => {
        listeners.storage.add(listener);
        return () => listeners.storage.delete(listener);
      },
    },
  }),
}));
vi.mock("../../wsConnectionState", () => ({ useWsConnectionState: () => connection.state }));

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
    reporting: {
      recordedTurnCount: 2,
      legacyCostEventCount: 0,
      inputTokenTurnCount: 2,
      outputTokenTurnCount: 2,
      cacheReadTokenTurnCount: 2,
      cacheWriteTokenTurnCount: 2,
      totalTokenTurnCount: 2,
    },
    ...overrides,
  };
}

const codex = {
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

const composition = {
  uncachedInputTokens: 200,
  outputTokens: 100,
  cacheReadTokens: 300,
  cacheWriteTokens: 0,
  unattributedTokens: 0,
};

function bucket(key: string, overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key,
    label: key.slice(5),
    startAt: `${key}T00:00:00.000Z`,
    endAt: null,
    metrics: metrics({ turnCount: 1, totalTokens: 600 }),
    composition,
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    range: "7d",
    timeZone: "UTC",
    generatedAt: "2026-08-15T12:00:00.000Z",
    metrics: metrics(),
    buckets: [bucket("2026-08-14"), bucket("2026-08-15")],
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
          reporting: {
            recordedTurnCount: 1,
            legacyCostEventCount: 0,
            inputTokenTurnCount: 0,
            outputTokenTurnCount: 0,
            cacheReadTokenTurnCount: 0,
            cacheWriteTokenTurnCount: 0,
            totalTokenTurnCount: 0,
          },
        }),
      },
    ],
    coverage: {
      coverageStartedAt: "2026-08-12T00:00:00.000Z",
      rangeStartedAt: "2026-08-09T00:00:00.000Z",
      partialHistory: true,
      historicalCostTurnCount: 0,
      tokenUnreportedTurnCount: 1,
      costUnreportedTurnCount: 1,
      providersMissingTokens: ["cursor"],
      providersMissingCost: ["cursor"],
    },
    nextBucketAt: null,
    projectScope: null,
    previousMetrics: null,
    ...overrides,
  };
}

const projectA = ProjectId.makeUnsafe("project-a");
const projectB = ProjectId.makeUnsafe("project-b");

function scoped(): UsageSummary {
  return summary({
    projectScope: {
      selectedProjectId: null,
      byProject: [
        {
          projectId: projectA,
          title: "Alpha",
          deleted: false,
          metrics: metrics({ totalTokens: 900 }),
        },
        { projectId: projectB, title: null, deleted: true, metrics: metrics({ totalTokens: 300 }) },
        {
          projectId: null,
          title: null,
          deleted: false,
          metrics: metrics({ totalTokens: 0, providerReportedCostUsd: 0.1 }),
        },
      ],
      topThreads: [
        {
          threadId: ThreadId.makeUnsafe("thread-live"),
          projectId: projectA,
          title: "Fix bug",
          deleted: false,
          metrics: metrics({ totalTokens: 800 }),
        },
        {
          threadId: ThreadId.makeUnsafe("thread-gone"),
          projectId: projectB,
          title: null,
          deleted: true,
          metrics: metrics({ totalTokens: 300 }),
        },
      ],
      threadCount: 14,
    },
  });
}

async function renderWithRouter(ui: ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
  });
  return render(<RouterProvider router={router} />);
}

const headers = () => [...document.querySelectorAll("th")].map((th) => th.textContent);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const limitsTab = () => <UsageDashboard search={{ tab: "limits" }} onSearchChange={() => {}} />;

async function renderDashboard(queryClient: QueryClient, ui: ReactNode = <UsageDashboard />) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  api.getQuotaHistory.mockResolvedValue({ generatedAt: codex.fetchedAt, series: [] });
});

afterEach(() => {
  vi.resetAllMocks();
  settings.current = { usagePriceOverrides: [], usageModelAliases: {} };
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  document.body.innerHTML = "";
});

describe("UsageDashboardView", () => {
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
        .element(page.getByRole("group", { name: "Token usage chart for 7 days (UTC)" }))
        .toBeVisible();
      await expect
        .element(page.getByText("$0.42 + unpriced", { exact: true }).first())
        .toBeVisible();
      await expect.element(page.getByText("Unpriced", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText("Unreported", { exact: true })).toBeVisible();
      await expect.element(page.getByText(/no price was estimated/i)).toBeVisible();
      await expect
        .element(page.getByText(/Complete retained recording is available from/))
        .toBeVisible();
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

  it("renders an entire older summary without coverage, scope, or bucket ends", async () => {
    const old = summary() as Record<string, unknown>;
    delete old.projectScope;
    delete old.previousMetrics;
    delete old.nextBucketAt;
    const strip = (value: UsageMetrics) => {
      const { reporting: _reporting, ...rest } = value;
      return rest;
    };
    const decoded = decodeUsageSummary({
      ...old,
      metrics: strip(summary().metrics),
      buckets: summary().buckets.map(({ composition: _c, endAt: _e, ...entry }) => ({
        ...entry,
        metrics: strip(entry.metrics),
      })),
      byProvider: summary().byProvider.map((entry) => ({
        ...entry,
        metrics: strip(entry.metrics),
      })),
    });
    expect(decoded.buckets[0]?.composition).toBeNull();
    expect(decoded.metrics.reporting).toBeNull();
    expect(decoded.projectScope).toBeNull();
    const screen = await render(
      <UsageDashboardView summary={decoded} range="7d" onRangeChange={() => {}} fetching={false} />,
    );
    try {
      await expect
        .element(page.getByRole("group", { name: "Token usage chart for 7 days (UTC)" }))
        .toBeVisible();
      expect(headers()).toContain("Usage records");
      await expect.element(page.getByRole("button", { name: "Recorded turns" })).toBeDisabled();
      await expect
        .element(page.getByText("Field coverage unavailable from this server."))
        .toBeVisible();
      await expect.element(page.getByText("Field coverage unavailable").first()).toBeVisible();
      await expect.element(page.getByText("Projects and threads")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows deltas, New, hidden deltas, and cache rate", async () => {
    const current = metrics({ totalTokens: 1_500, providerReportedCostUsd: 1, pricedTurnCount: 1 });
    const screen = await render(
      <UsageDashboardView
        summary={summary({
          metrics: current,
          previousMetrics: metrics({
            totalTokens: 1_000,
            providerReportedCostUsd: 0,
            pricedTurnCount: 1,
          }),
        })}
        range="7d"
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByText("+50% vs previous 7 days")).toBeVisible();
      await expect.element(page.getByText("New vs previous 7 days")).toBeVisible();
      await expect.element(page.getByText("60% of input served from cache")).toBeVisible();
      await screen.rerender(
        <UsageDashboardView
          summary={summary({
            metrics: current,
            previousMetrics: metrics({
              totalTokens: 1_000,
              pricedTurnCount: 0,
              reporting: { ...metrics().reporting!, totalTokenTurnCount: 1 },
            }),
          })}
          range="7d"
          fetching={false}
        />,
      );
      await expect.element(page.getByText(/vs previous 7 days/)).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("filters by project, links live threads, and labels deleted and unattributed rows", async () => {
    const onProjectChange = vi.fn();
    const screen = await renderWithRouter(
      <UsageDashboardView
        summary={scoped()}
        range="7d"
        fetching={false}
        projectOptions={[{ id: projectA, label: "Alpha" }]}
        onProjectChange={onProjectChange}
      />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Alpha" })).toBeVisible();
      await expect.element(page.getByText("Unattributed historical cost")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Unknown project (deleted)" }))
        .toBeVisible();
      expect(headers()).toContain("Share");
      await page.getByRole("button", { name: "Alpha" }).click();
      expect(onProjectChange).toHaveBeenCalledWith(projectA);
      await page.getByRole("button", { name: "Threads" }).click();
      await expect
        .element(page.getByRole("link", { name: "Fix bug" }))
        .toHaveAttribute("href", "/thread-live");
      await expect.element(page.getByText("Untitled thread (deleted)")).toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Untitled thread (deleted)" }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Showing top 2 of 14 threads")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shares projects of the whole catalog and threads of the selected total", async () => {
    const value = scoped();
    const screen = await renderWithRouter(
      <UsageDashboardView
        summary={{
          ...value,
          metrics: metrics({ totalTokens: 300 }),
          projectScope: { ...value.projectScope!, selectedProjectId: projectB },
        }}
        range="7d"
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
      // 900 of 1,200 catalog tokens, not 900 of the filtered 300.
      await expect.element(page.getByRole("cell", { name: "75%" })).toBeVisible();
      await expect.element(page.getByRole("cell", { name: "25%" })).toBeVisible();
      expect(document.body.textContent).not.toContain("300%");
    } finally {
      await screen.unmount();
    }
  });

  it("ranks and shares rows by the selected metric", async () => {
    const value = scoped();
    const unknownCost = metrics({
      totalTokens: 0,
      providerReportedCostUsd: null,
      pricedTurnCount: 0,
    });
    const ranked: UsageSummary = {
      ...value,
      byProvider: [
        ...value.byProvider,
        {
          provider: "claudeAgent",
          model: "claude-opus",
          metrics: metrics({ totalTokens: 100, providerReportedCostUsd: 2 }),
        },
      ],
      projectScope: {
        ...value.projectScope!,
        byProject: [
          {
            projectId: projectA,
            title: "Alpha",
            deleted: false,
            metrics: metrics({ totalTokens: 900, providerReportedCostUsd: 0.1 }),
          },
          {
            projectId: projectB,
            title: "Beta",
            deleted: false,
            metrics: metrics({ totalTokens: 300, providerReportedCostUsd: 0.3 }),
          },
          { projectId: null, title: null, deleted: false, metrics: unknownCost },
        ],
      },
    };
    const view = (metric: "tokens" | "cost") => (
      <UsageDashboardView summary={ranked} range="7d" fetching={false} metric={metric} />
    );
    const tables = () => [...document.querySelectorAll("table")];
    const projectRows = () =>
      [...tables()[0]!.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      );
    const models = () =>
      [...tables()[1]!.querySelectorAll("tbody tr td:nth-child(2)")].map(
        (cell) => cell.textContent,
      );
    const screen = await renderWithRouter(view("tokens"));
    try {
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
      expect(projectRows().map((row) => [row[0], row.at(-1)])).toEqual([
        ["Alpha", "75%"],
        ["Beta", "25%"],
        ["Unattributed historical cost", "0%"],
      ]);
      expect(models()).toEqual(["gpt-5.6", "claude-opus", "cursor-agent"]);

      await screen.rerender(view("cost"));
      await expect.poll(() => projectRows()[0]?.[0]).toBe("Beta");
      // An unknown cost has no cost share.
      expect(projectRows().map((row) => [row[0], row.at(-1)])).toEqual([
        ["Beta", "75%"],
        ["Alpha", "25%"],
        ["Unattributed historical cost", ""],
      ]);
      expect(models()).toEqual(["claude-opus", "gpt-5.6", "cursor-agent"]);
    } finally {
      await screen.unmount();
    }
  });

  it("hides the share column when there are no tokens", async () => {
    const value = scoped();
    const screen = await renderWithRouter(
      <UsageDashboardView
        summary={{ ...value, metrics: metrics({ totalTokens: 0 }) }}
        range="7d"
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
      // Projects still share the catalog's tokens.
      expect(headers()).toContain("Share");
      await page.getByRole("button", { name: "Threads" }).click();
      await expect.element(page.getByText(/Showing top 2 of 14 threads/)).toBeVisible();
      expect(headers()).not.toContain("Share");
    } finally {
      await screen.unmount();
    }
  });

  it("offers a Set price shortcut for unpriced models", async () => {
    const onSetPrice = vi.fn();
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
        range="7d"
        fetching={false}
        onSetPrice={onSetPrice}
      />,
    );
    try {
      await page.getByRole("button", { name: "Set price for gpt-5.6" }).click();
      expect(onSetPrice).toHaveBeenCalledWith("codex", "gpt-5.6");
    } finally {
      await screen.unmount();
    }
  });
});

describe("usage chart", () => {
  it("switches modes and shows cost empty and zero states", async () => {
    const onMetricChange = vi.fn();
    const view = (value: UsageSummary, metric: "tokens" | "cost" | "turns") => (
      <UsageDashboardView
        summary={value}
        range="7d"
        fetching={false}
        metric={metric}
        onMetricChange={onMetricChange}
      />
    );
    const screen = await render(view(summary(), "tokens"));
    try {
      await page.getByRole("button", { name: "Cost", exact: true }).click();
      expect(onMetricChange).toHaveBeenCalledWith("cost");
      await screen.rerender(view(summary(), "cost"));
      await expect
        .element(page.getByRole("group", { name: "Cost chart for 7 days (UTC)" }))
        .toBeVisible();
      await expect.element(page.getByRole("list", { name: "Cost chart legend" })).toBeVisible();
      await screen.rerender(view(summary(), "turns"));
      await expect
        .element(page.getByRole("group", { name: "Recorded turns chart for 7 days (UTC)" }))
        .toBeVisible();
      const unpriced = summary({
        buckets: summary().buckets.map((entry) => ({
          ...entry,
          metrics: metrics({ pricedTurnCount: 0, providerReportedCostUsd: null }),
        })),
      });
      await screen.rerender(view(unpriced, "cost"));
      await expect.element(page.getByText("No priced activity in this range")).toBeVisible();
      const zeroCost = summary({
        buckets: summary().buckets.map((entry) => ({
          ...entry,
          metrics: metrics({ pricedTurnCount: 1, providerReportedCostUsd: 0 }),
        })),
      });
      await screen.rerender(view(zeroCost, "cost"));
      await expect
        .element(page.getByRole("group", { name: "Cost chart for 7 days (UTC)" }))
        .toBeVisible();
      expect(document.body.textContent).toContain("$0.00");
    } finally {
      await screen.unmount();
    }
  });

  it("has one tab stop, arrow/Home/End navigation, a focus tooltip, and pinned details", async () => {
    const buckets = Array.from({ length: 7 }, (_, index) =>
      bucket(`2026-08-${(9 + index).toString().padStart(2, "0")}`, {
        metrics: metrics({ totalTokens: index === 3 ? 0 : 100 * (index + 1) }),
        composition:
          index === 3
            ? { ...composition, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
            : composition,
      }),
    );
    const screen = await render(
      <UsageDashboardView summary={summary({ buckets })} range="7d" fetching={false} />,
    );
    try {
      const columns = document.querySelectorAll<HTMLButtonElement>("[data-chart-column]");
      expect([...columns].filter((column) => column.tabIndex === 0)).toHaveLength(1);
      expect(columns[6]!.tabIndex).toBe(0);
      columns[6]!.focus();
      await expect.element(page.getByTestId("usage-chart-tooltip")).toBeVisible();
      await expect
        .element(page.getByTestId("usage-chart-tooltip"))
        .toHaveTextContent(/Reported cost: \$0\.42.*Recorded turns: 2/);
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(columns[0]);
      await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
      expect(document.activeElement).toBe(columns[3]);
      // Zero-valued buckets are selectable.
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByRole("region", { name: "Selected interval details" }))
        .toBeVisible();
      await expect.element(page.getByText("Aug 12, 2026 (UTC)").last()).toBeVisible();
      await page.getByRole("button", { name: "Next interval" }).click();
      await expect.element(page.getByText("Aug 13, 2026 (UTC)").last()).toBeVisible();
      columns[4]!.focus();
      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(columns[6]);
      await userEvent.keyboard("{Escape}");
      await expect
        .element(page.getByRole("region", { name: "Selected interval details" }))
        .not.toBeInTheDocument();
      await page.getByText("Show data table").click();
      await expect.element(page.getByRole("cell", { name: "Aug 15, 2026 (UTC)" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps positive bar slots for 90 buckets at 320px and selects first, middle, and last", async () => {
    await page.viewport(320, 900);
    const buckets = Array.from({ length: 90 }, (_, index) =>
      bucket(new Date(Date.UTC(2026, 4, 18 + index)).toISOString().slice(0, 10), {
        metrics: metrics({ totalTokens: index % 10 === 0 ? 0 : 100 }),
      }),
    );
    const screen = await render(
      <UsageDashboardView
        summary={summary({ range: "90d", buckets })}
        range="90d"
        fetching={false}
      />,
    );
    try {
      const columns = [...document.querySelectorAll<HTMLButtonElement>("[data-chart-column]")];
      expect(columns).toHaveLength(90);
      for (const column of columns)
        expect(
          column.querySelector<HTMLElement>("[data-chart-bar]")!.getBoundingClientRect().width,
        ).toBeGreaterThan(0);
      for (const index of [0, 45, 89]) {
        await userEvent.click(columns[index]!);
        expect(columns[index]!.getAttribute("aria-pressed")).toBe("true");
        await userEvent.click(columns[index]!);
      }
    } finally {
      await screen.unmount();
      await page.viewport(1280, 900);
    }
  });

  it("keeps the selection across refreshes and clamps when the key leaves the range", async () => {
    const screen = await render(
      <UsageDashboardView summary={summary()} range="7d" fetching={false} />,
    );
    try {
      let columns = document.querySelectorAll<HTMLButtonElement>("[data-chart-column]");
      await userEvent.click(columns[0]!);
      expect(columns[0]!.getAttribute("aria-pressed")).toBe("true");
      await screen.rerender(<UsageDashboardView summary={summary()} range="7d" fetching={false} />);
      columns = document.querySelectorAll<HTMLButtonElement>("[data-chart-column]");
      expect(columns[0]!.getAttribute("aria-pressed")).toBe("true");
      await screen.rerender(
        <UsageDashboardView
          summary={summary({ buckets: [bucket("2026-08-15"), bucket("2026-08-16")] })}
          range="7d"
          fetching={false}
        />,
      );
      await expect
        .poll(() =>
          document
            .querySelectorAll<HTMLButtonElement>("[data-chart-column]")[1]
            ?.getAttribute("aria-pressed"),
        )
        .toBe("true");
    } finally {
      await screen.unmount();
    }
  });
});

describe("query-connected usage dashboard", () => {
  it("keeps successful history visible after a rejected refresh", async () => {
    api.getSummary.mockResolvedValueOnce(summary()).mockRejectedValue(new Error("offline"));
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      await page.getByRole("button", { name: "Refresh usage" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Historical usage refresh failed.");
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      await page.getByRole("button", { name: "Dismiss refresh error" }).click();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
      // History refresh never forces account probes.
      expect(api.getAccounts).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("forces account refresh independently, reports queued jobs, and polls memory only", async () => {
    const running = accounts().map((entry) => ({ ...entry, refreshState: "refreshing" as const }));
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts
      .mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(running)
      .mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient, limitsTab());
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await page.getByRole("button", { name: "Refresh limits" }).click();
      await expect.element(page.getByText("Refresh queued.")).toBeVisible();
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(3);
      expect(api.getAccounts.mock.calls.map((call) => call[0])).toEqual([
        { refresh: "if-stale" },
        { refresh: "force" },
        { refresh: "none" },
      ]);
      await expect.element(page.getByRole("button", { name: "Refresh limits" })).toBeEnabled();
      await page.getByRole("button", { name: "30 days" }).click();
      expect(api.getAccounts).toHaveBeenCalledTimes(3);
      expect(usageAccountsQueryOptions().refetchIntervalInBackground).toBe(false);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("explains when a forced refresh starts no job", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient, limitsTab());
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await page.getByRole("button", { name: "Refresh limits" }).click();
      await expect.element(page.getByText(/No new refresh job started/)).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("shows account errors independently of history state", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValueOnce(accounts()).mockRejectedValue(new Error("offline"));
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      // The Activity tab keeps plain account cards: no refresh controls or history.
      await expect
        .element(page.getByRole("button", { name: "Refresh limits" }))
        .not.toBeInTheDocument();
      expect(api.getQuotaHistory).not.toHaveBeenCalled();
      queryClient.setQueryData(usageQueryKeys.accounts, accounts(), {
        updatedAt: Date.now() - 301_000,
      });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Account snapshots could not be refreshed.");
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("lets Retry join a pending forced refresh instead of cancelling it", async () => {
    let releaseForce!: (value: UsageAccounts) => void;
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts
      .mockResolvedValueOnce(accounts())
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(
        () =>
          new Promise<UsageAccounts>((resolve) => {
            releaseForce = resolve;
          }),
      )
      .mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient, limitsTab());
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      await page.getByRole("button", { name: "Refresh limits" }).click();
      await expect.element(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "Refresh limits" }).click();
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(3);
      // The previous error and its Retry stay visible while the force runs.
      await page.getByRole("button", { name: "Retry" }).click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.getAccounts).toHaveBeenCalledTimes(3);
      releaseForce(accounts());
      await expect.element(page.getByRole("button", { name: "Refresh limits" })).toBeEnabled();
      expect(api.getAccounts.mock.calls.map((call) => call[0])).toEqual([
        { refresh: "if-stale" },
        { refresh: "force" },
        { refresh: "force" },
      ]);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("refreshes history on usage events (throttled) and storage purges, not on other events", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      expect(api.getSummary).toHaveBeenCalledTimes(1);
      for (const listener of listeners.domain) listener({ type: "thread.created" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(api.getSummary).toHaveBeenCalledTimes(1);
      // The first usage event refreshes immediately; the rest of the burst and
      // a storage purge inside the 5-second window collapse into one trailing
      // refresh.
      for (let index = 0; index < 5; index++)
        for (const listener of listeners.domain) listener({ type: "thread.usage-recorded" });
      await expect.poll(() => api.getSummary.mock.calls.length).toBe(2);
      for (const listener of listeners.storage) listener();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(api.getSummary).toHaveBeenCalledTimes(2);
      await expect
        .poll(() => api.getSummary.mock.calls.length, { timeout: 6_000, interval: 250 })
        .toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(api.getSummary).toHaveBeenCalledTimes(3);
      // Account snapshots are never re-probed by history events.
      expect(api.getAccounts).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
    expect(listeners.domain.size).toBe(0);
    expect(listeners.storage.size).toBe(0);
  });

  it("keeps a forced refresh pending across tab switches", async () => {
    let releaseForce!: (value: UsageAccounts) => void;
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts
      .mockResolvedValueOnce(accounts())
      .mockImplementationOnce(
        () =>
          new Promise<UsageAccounts>((resolve) => {
            releaseForce = resolve;
          }),
      )
      .mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await page.getByRole("tab", { name: "Limits" }).click();
      await page.getByRole("button", { name: "Refresh limits" }).click();
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(2);
      await page.getByRole("tab", { name: "Activity" }).click();
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      await page.getByRole("tab", { name: "Limits" }).click();
      // The remounted panel still sees the pending forced refresh.
      await expect.element(page.getByRole("button", { name: "Refresh limits" })).toBeDisabled();
      releaseForce(accounts());
      await expect.element(page.getByRole("button", { name: "Refresh limits" })).toBeEnabled();
      expect(api.getAccounts).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("rolls over at the next bucket boundary, deferring to reconnect while offline", async () => {
    const soon = () => new Date(Date.now() + 400).toISOString();
    api.getSummary.mockImplementation(async () => summary({ nextBucketAt: soon() }));
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      expect(api.getSummary).toHaveBeenCalledTimes(1);
      await expect.poll(() => api.getSummary.mock.calls.length, { timeout: 3_000 }).toBe(2);
      // Offline at the boundary: only mark stale; reconnect fetches.
      api.getSummary.mockImplementation(async () =>
        summary({ nextBucketAt: new Date(Date.now() + 3_600_000).toISOString() }),
      );
      onlineManager.setOnline(false);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(api.getSummary).toHaveBeenCalledTimes(2);
      onlineManager.setOnline(true);
      await expect.poll(() => api.getSummary.mock.calls.length).toBe(3);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("refreshes a cached summary whose bucket boundary already passed, once", async () => {
    const expired = summary({ nextBucketAt: new Date(Date.now() - 60_000).toISOString() });
    api.getSummary.mockResolvedValue(expired);
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    queryClient.setQueryData(
      usageQueryKeys.summary("7d", Intl.DateTimeFormat().resolvedOptions().timeZone),
      expired,
    );
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      await expect.poll(() => api.getSummary.mock.calls.length).toBe(1);
      // The refreshed summary still carries the expired boundary: no loop.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(api.getSummary).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("refreshes stale accounts on focus and reconnect without background polling", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByText("Codex — default configuration")).toBeVisible();
      queryClient.setQueryData(usageQueryKeys.accounts, accounts(), {
        updatedAt: Date.now() - 301_000,
      });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(2);
      queryClient.setQueryData(usageQueryKeys.accounts, accounts(), {
        updatedAt: Date.now() - 301_000,
      });
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(3);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it.each(["pending", "failed"])(
    "renders account snapshots while initial history is %s",
    async (state) => {
      if (state === "pending") api.getSummary.mockImplementation(() => new Promise(() => {}));
      else api.getSummary.mockRejectedValue(new Error("history offline"));
      api.getAccounts.mockResolvedValue(accounts());
      const queryClient = client();
      const screen = await renderDashboard(queryClient);
      try {
        await expect
          .element(page.getByRole("region", { name: "Account usage and limits" }))
          .toBeVisible();
        await expect
          .element(page.getByRole("progressbar", { name: "Codex · 5-hour limit" }))
          .toBeVisible();
        if (state === "failed")
          await expect
            .element(page.getByRole("heading", { name: "Usage is unavailable" }))
            .toBeVisible();
      } finally {
        await screen.unmount();
        queryClient.clear();
      }
    },
  );

  it("shows an unsupported message for a project filter on an older server", async () => {
    api.getSummary.mockResolvedValue(summary({ projectScope: null }));
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{ projectId: projectA }} onSearchChange={() => {}} />,
    );
    try {
      await expect
        .element(page.getByText(/Project filtering is unsupported by this server/))
        .toBeVisible();
      await expect.element(page.getByText("Total tokens")).not.toBeInTheDocument();
      expect(api.getSummary).toHaveBeenCalledWith(expect.objectContaining({ projectId: projectA }));
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("treats a project scope mismatch as an error", async () => {
    api.getSummary.mockResolvedValue(scoped());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{ projectId: projectB }} onSearchChange={() => {}} />,
    );
    try {
      await expect.element(page.getByText(/different project than requested/)).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("hides filtered providers from history and account cards on both tabs", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const onHiddenProvidersChange = vi.fn();
    const queryClient = client();
    const view = (tab: "activity" | "limits", hiddenProviders: ReadonlyArray<ProviderKind>) => (
      <QueryClientProvider client={queryClient}>
        <UsageDashboard
          search={{ tab }}
          onSearchChange={() => {}}
          hiddenProviders={hiddenProviders}
          onHiddenProvidersChange={onHiddenProvidersChange}
        />
      </QueryClientProvider>
    );
    const screen = await render(view("activity", []));
    const accountCard = () => page.getByRole("heading", { name: "Codex — default configuration" });
    try {
      await expect.element(accountCard()).toBeVisible();
      await page.getByRole("button", { name: "Usage providers" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Codex" }).click();
      expect(onHiddenProvidersChange).toHaveBeenLastCalledWith(["codex"]);

      await screen.rerender(view("activity", ["codex", "cursor"]));
      await vi.waitFor(() =>
        expect(api.getSummary).toHaveBeenLastCalledWith(
          expect.objectContaining({ hiddenProviders: ["codex", "cursor"] }),
        ),
      );
      await expect
        .element(page.getByRole("button", { name: "Usage providers" }))
        .toHaveTextContent(/providers/);
      await expect.element(accountCard()).not.toBeInTheDocument();
      await screen.rerender(view("limits", ["codex"]));
      await expect.element(page.getByRole("button", { name: "Refresh limits" })).toBeVisible();
      await expect.element(accountCard()).not.toBeInTheDocument();
      await screen.rerender(view("limits", []));
      await expect.element(accountCard()).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("switches views with page keys, leaves typing alone and goes back on Escape", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const onSearchChange = vi.fn();
    const onBack = vi.fn();
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{}} onSearchChange={onSearchChange} onBack={onBack} />,
    );
    const field = document.createElement("input");
    document.body.append(field);
    try {
      await expect.element(page.getByRole("tab", { name: "Activity" })).toBeVisible();
      await vi.waitFor(async () => {
        await userEvent.keyboard("c");
        expect(onSearchChange).toHaveBeenLastCalledWith({ tab: "activity", metric: "cost" });
      });
      await userEvent.keyboard("l");
      expect(onSearchChange).toHaveBeenLastCalledWith({ tab: "limits" });
      await userEvent.keyboard("3");
      expect(onSearchChange).toHaveBeenLastCalledWith({ range: "30d" });
      await userEvent.keyboard("{Escape}");
      expect(onBack).toHaveBeenCalledTimes(1);

      onSearchChange.mockClear();
      field.focus();
      await userEvent.keyboard("ct4{Escape}");
      expect(onSearchChange).not.toHaveBeenCalled();
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      field.remove();
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("preserves other params when one control changes and falls back to saved defaults", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const onSearchChange = vi.fn();
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard
        search={{ metric: "cost" }}
        defaults={{ tab: "activity", range: "30d" }}
        onSearchChange={onSearchChange}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "30 days" }))
        .toHaveAttribute("aria-pressed", "true");
      expect(api.getSummary).toHaveBeenCalledWith(expect.objectContaining({ range: "30d" }));
      await page.getByRole("button", { name: "7 days" }).click();
      expect(onSearchChange).toHaveBeenCalledWith({ range: "7d" });
      await page.getByRole("tab", { name: "Limits" }).click();
      expect(onSearchChange).toHaveBeenCalledWith({ tab: "limits" });
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("opens the price editor prefilled from Set price", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await page.getByRole("button", { name: "Set price for cursor-agent" }).click();
      await expect
        .element(page.getByLabelText("Model", { exact: true }))
        .toHaveValue("cursor-agent");
      await expect.element(page.getByRole("combobox", { name: /^Provider/ })).toHaveValue("cursor");
      await expect.element(page.getByLabelText("Input price")).toHaveFocus();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("prefills Set price from an existing override instead of blank rates", async () => {
    settings.current = {
      usagePriceOverrides: [
        {
          provider: "cursor",
          model: "cursor-agent",
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 15,
          cacheReadUsdPerMillion: 0.3,
          cacheWriteUsdPerMillion: null,
        },
      ],
      usageModelAliases: {},
    };
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await page.getByRole("button", { name: "Set price for cursor-agent" }).click();
      await expect.element(page.getByLabelText("Input price")).toHaveValue(3);
      await expect.element(page.getByLabelText("Output price")).toHaveValue(15);
      await expect.element(page.getByLabelText("Cache read price")).toHaveValue(0.3);
      await expect.element(page.getByLabelText("Cache write price")).toHaveValue(null);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});

describe("limits", () => {
  const claudeAccount = (overrides: Partial<UsageAccounts[number]["sections"][number]> = {}) => {
    const now = Date.now();
    const fetchedAt = new Date(now - 60_000).toISOString();
    const resetsAt = new Date(now + (5 * 24 + 10) * 3_600_000 + 120_000).toISOString();
    const account: UsageAccounts[number] = {
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
          lastAttemptAt: fetchedAt,
          errorCode: null,
          snapshot: {
            fetchedAt,
            data: {
              subscriptionLabel: "Pro",
              limitsAvailable: true,
              windows: [
                { key: "seven_day", label: "Weekly limit", utilization: 40, resetsAt },
                {
                  key: "five_hour",
                  label: "5-hour limit",
                  utilization: 10,
                  resetsAt: new Date(now - 60_000).toISOString(),
                },
              ],
              extraUsage: null,
            },
          },
          ...overrides,
        } as UsageAccounts[number]["sections"][number],
      ],
    };
    return { account, fetchedAt, resetsAt, now };
  };

  it("renders reset countdowns in days, expired resets, and forecasts from history", async () => {
    const { account, resetsAt, now } = claudeAccount();
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue([account]);
    api.getQuotaHistory.mockResolvedValue({
      generatedAt: new Date(now).toISOString(),
      series: [
        {
          accountKey: "claude:test",
          windowKey: "seven_day",
          resetsAt,
          samples: [
            { at: new Date(now - 20 * 3_600_000).toISOString(), usedPercent: 10 },
            { at: new Date(now - 10 * 3_600_000).toISOString(), usedPercent: 25 },
          ],
        },
      ],
    });
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{ tab: "limits" }} onSearchChange={() => {}} />,
    );
    try {
      await expect.element(page.getByText(/in 5d 10h/)).toBeVisible();
      await expect
        .element(page.getByText("Reset time passed; awaiting updated usage"))
        .toBeVisible();
      await expect.element(page.getByText(/At this pace: limit reached/)).toBeVisible();
      // The projected hit is days away, so the forecast names the day.
      await expect
        .element(page.getByText(/At this pace: limit reached/))
        .toHaveTextContent(/limit reached ~[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}/);
      await expect.element(page.getByTestId("quota-sparkline")).toBeInTheDocument();
      await expect
        .element(page.getByText(/range affects only Codex UTC token history/))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("shows no projection when history is unavailable, and labels restored snapshots", async () => {
    const { account } = claudeAccount({ lastAttemptAt: null, outcome: "unavailable" });
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue([account]);
    api.getQuotaHistory.mockRejectedValue(new Error("unknown method"));
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{ tab: "limits" }} onSearchChange={() => {}} />,
    );
    try {
      await expect.element(page.getByText(/Last known before restart/)).toBeVisible();
      await expect.poll(() => api.getQuotaHistory.mock.calls.length).toBeGreaterThan(0);
      await expect.element(page.getByText(/At this pace: limit reached/)).not.toBeInTheDocument();
      await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("renders Claude unknown and zero meters distinctly alongside Codex", async () => {
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
                {
                  key: "five_hour",
                  label: "5-hour limit",
                  utilization: null,
                  resetsAt: "bad date",
                },
                { key: "seven_day", label: "Weekly limit", utilization: 0, resetsAt: null },
              ],
              extraUsage: { enabled: true, utilization: 105.4 },
            },
          },
        },
      ],
    };
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
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
        .toHaveAttribute("aria-valuenow", "100");
      await expect.element(page.getByText("Unknown", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Claude · Extra usage" }))
        .toHaveAttribute("aria-valuetext", "0% remaining");
      await expect.element(page.getByText(/over limit \(105% used\)/)).toBeVisible();
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
      await expect
        .element(page.getByText(message, { exact: state !== "unavailable" }))
        .toBeVisible();
      await expect.element(page.getByRole("heading", { name: "F5 activity" })).toBeVisible();
      if (state === "unavailable")
        await expect.element(page.getByText(/Showing data from/)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("gives each Codex rate-limit family's meters a distinct accessible name", async () => {
    const [codexAccount] = accounts();
    const limits = codexAccount!.sections[1]!;
    const spark = { ...codex.rateLimits[0]!, id: "codex_spark", name: "Spark" };
    const twoFamilies = {
      ...codexAccount!,
      sections: [
        codexAccount!.sections[0]!,
        {
          ...limits,
          snapshot: {
            fetchedAt: codex.fetchedAt,
            data: { rateLimits: [codex.rateLimits[0]!, spark] },
          },
        },
      ],
    } as UsageAccounts[number];
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
        accounts={[twoFamilies]}
        range="7d"
        fetching={false}
      />,
    );
    try {
      await expect
        .element(page.getByRole("progressbar", { name: "Codex · 5-hour limit" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Spark · 5-hour limit" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("uses the Codex snapshot's UTC clock for account tokens", async () => {
    const screen = await render(
      <UsageDashboardView
        summary={{ ...summary(), generatedAt: "2026-09-05T12:00:00Z" }}
        accounts={accounts()}
        range="24h"
        onRangeChange={() => {}}
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByText("Account tokens · Today (UTC)")).toBeVisible();
      await expect.element(page.getByText("40K", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("confirms the named account and window before redeeming and reuses ambiguous keys", async () => {
    api.consumeResetCredit
      .mockRejectedValueOnce(new Error("lost connection"))
      .mockResolvedValue({ outcome: "alreadyRedeemed" });
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ResetCreditButton
          instanceId={ProviderInstanceId.make("codex-test")}
          accountName="Work account"
          windowName="5-hour window"
          count={1}
        />
      </QueryClientProvider>,
    );
    try {
      await page.getByRole("button", { name: "Use reset credit (1)" }).click();
      await expect
        .element(page.getByText("This redeems one credit for Work account to reset 5-hour window."))
        .toBeVisible();
      expect(api.consumeResetCredit).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(api.consumeResetCredit).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Use reset credit (1)" }).click();
      await page.getByRole("button", { name: "Confirm redemption" }).click();
      await expect.element(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button", { name: "Confirm redemption" }).click();
      await expect.poll(() => api.consumeResetCredit.mock.calls.length).toBe(2);
      expect(api.consumeResetCredit.mock.calls[0]).toEqual(api.consumeResetCredit.mock.calls[1]);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
