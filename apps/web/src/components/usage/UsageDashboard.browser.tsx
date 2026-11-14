import "../../index.css";

import {
  type ClaudeLimitResetGrant,
  type CodexAccountRateLimit,
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
import { ClaudeGrantButton } from "./ClaudeLimitResets";
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
  it("shows native model calls separately from turns while refreshing history", async () => {
    const native = metrics({
      turnCount: 0,
      reportedTokenTurnCount: 0,
      nativeInferenceCount: 2,
      unpricedNativeInferenceCount: 2,
      pricedTurnCount: 0,
      unpricedTurnCount: 0,
      providerReportedCostUsd: null,
      totalTokens: 120,
      reporting: {
        recordedTurnCount: 0,
        legacyCostEventCount: 0,
        inputTokenTurnCount: 0,
        outputTokenTurnCount: 0,
        cacheReadTokenTurnCount: 0,
        cacheWriteTokenTurnCount: 0,
        totalTokenTurnCount: 0,
      },
    });
    const screen = await render(
      <UsageDashboardView
        summary={summary({
          nativeHistoryStatus: "refreshing",
          metrics: native,
          byProvider: [{ provider: "muse", model: "unknown-muse", metrics: native }],
          projectScope: {
            selectedProjectId: null,
            byProject: [{ projectId: null, title: null, deleted: false, metrics: native }],
            topThreads: [],
            threadCount: 0,
          },
        })}
        range="7d"
        onRangeChange={() => {}}
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByText("Refreshing Muse Code history…")).toBeVisible();
      await expect
        .element(
          page.getByText(
            "2 native Muse model calls included. Model calls are separate from recorded turns.",
          ),
        )
        .toBeVisible();
      await expect.element(page.getByText("Usage without a project")).toBeVisible();
      await expect.element(page.getByText("unknown-muse")).toBeVisible();
    } finally {
      await screen.unmount();
    }
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
      // Caveats live in the collapsed notes at the bottom of the tab.
      await page.getByRole("button", { name: "About these numbers" }).click();
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
              providerReportedCostUsd: null,
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
      await expect.element(page.getByText("Usage without a project")).toBeVisible();
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
    const table = (caption: string) =>
      [...document.querySelectorAll("table")].find(
        (element) => element.querySelector("caption")?.textContent === caption,
      )!;
    const projectRows = () =>
      [...table("Projects").querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      );
    const models = () =>
      [...table("Providers and models").querySelectorAll("tbody tr td:nth-child(2)")].map(
        (cell) => cell.textContent,
      );
    const screen = await renderWithRouter(view("tokens"));
    try {
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
      expect(projectRows().map((row) => [row[0], row.at(-1)])).toEqual([
        ["Alpha", "75%"],
        ["Beta", "25%"],
        ["Usage without a project", "0%"],
      ]);
      expect(models()).toEqual(["gpt-5.6", "claude-opus", "cursor-agent"]);

      await screen.rerender(view("cost"));
      await expect.poll(() => projectRows()[0]?.[0]).toBe("Beta");
      // An unknown cost has no cost share.
      expect(projectRows().map((row) => [row[0], row.at(-1)])).toEqual([
        ["Beta", "75%"],
        ["Alpha", "25%"],
        ["Usage without a project", ""],
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
      await page.getByRole("button", { name: "Refresh usage" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Historical usage refresh failed.");
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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
      // Activity leads with the glance tiles: no refresh controls or quota history.
      await expect
        .element(page.getByRole("button", { name: "Open Codex — default configuration limits" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Refresh limits" }))
        .not.toBeInTheDocument();
      expect(api.getQuotaHistory).not.toHaveBeenCalled();
      queryClient.setQueryData(usageQueryKeys.accounts, accounts(), {
        updatedAt: Date.now() - 301_000,
      });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await expect.poll(() => api.getAccounts.mock.calls.length).toBe(2);
      // The failed account read keeps the last tiles and leaves history alone.
      await expect
        .element(page.getByRole("button", { name: "Open Codex — default configuration limits" }))
        .toBeVisible();
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
      await page.getByRole("tab", { name: "Limits" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Account snapshots could not be refreshed.");
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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
        // Limits at a glance renders first and never waits on history.
        const glance = page.getByRole("region", { name: "Limits at a glance" });
        await expect.element(glance).toBeVisible();
        await expect
          .element(glance.getByTestId("limits-glance-tile").first())
          // The fixture's resets have passed, so the tile waits for fresh usage.
          .toHaveTextContent(/Codex — default configuration.*awaiting updated usage/);
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
      expect(api.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: projectA }),
        expect.anything(),
      );
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
    // A glance tile on Activity, an account section on Limits.
    const accountCard = () => page.getByText("Codex — default configuration", { exact: true });
    try {
      await expect.element(accountCard()).toBeVisible();
      await page.getByRole("button", { name: "Usage providers" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Codex" }).click();
      expect(onHiddenProvidersChange).toHaveBeenLastCalledWith(["codex"]);

      await screen.rerender(view("activity", ["codex", "cursor"]));
      await vi.waitFor(() =>
        expect(api.getSummary).toHaveBeenLastCalledWith(
          expect.objectContaining({ hiddenProviders: ["codex", "cursor"] }),
          expect.anything(),
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
      await userEvent.keyboard("p");
      expect(onSearchChange).toHaveBeenLastCalledWith({ tab: "pricing" });
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
      expect(api.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({ range: "30d" }),
        expect.anything(),
      );
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
      await expect
        .element(page.getByRole("combobox", { name: "Provider" }))
        .toHaveTextContent("Cursor");
      await expect.element(page.getByLabelText("Input price")).toHaveFocus();
      // The dialog opens in place: Activity stays selected behind the modal.
      await expect
        .element(page.getByRole("tab", { name: "Activity", includeHidden: true }))
        .toHaveAttribute("aria-selected", "true");
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
      await expect.element(page.getByText(/^in 5d 10h/)).toBeVisible();
      // The 5-hour reset has passed, which leaves one live window and nothing to compare.
      await expect.element(page.getByTestId("tightest-limit")).not.toBeInTheDocument();
      // 40% used with about 23% of the week elapsed; the expired 5-hour window has no tick.
      await expect.element(page.getByText("17 pts ahead of pace")).toBeVisible();
      expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(1);
      await expect
        .element(page.getByText("Reset time passed; awaiting updated usage"))
        .toBeVisible();
      await expect.element(page.getByText(/At this pace: limit reached/)).toBeVisible();
      // The projected hit is days away, so the forecast names the day.
      await expect
        .element(page.getByText(/At this pace: limit reached/))
        .toHaveTextContent(/limit reached ~[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}/);
      await expect.element(page.getByTestId("quota-sparkline")).toBeInTheDocument();
      await page.getByRole("button", { name: "About these numbers" }).click();
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

  it("meters an overspent monthly budget once, in place of the extra-usage meter", async () => {
    const fetchedAt = "2026-10-01T00:00:00.000Z";
    const claude: UsageAccounts[number] = {
      key: "claude:enterprise",
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
              subscriptionLabel: null,
              limitsAvailable: true,
              windows: [
                {
                  key: "monthly_spend",
                  label: "Monthly spend",
                  utilization: 105.4,
                  resetsAt: null,
                },
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
        accounts={[claude]}
        range="7d"
        onRangeChange={() => {}}
        fetching={false}
      />,
    );
    try {
      await expect
        .element(page.getByRole("progressbar", { name: "Claude · Monthly spend" }))
        .toHaveAttribute("aria-valuetext", "0% remaining");
      await expect.element(page.getByText(/over limit \(105% used\)/)).toBeVisible();
      await expect.element(page.getByText("Extra usage enabled")).toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Claude · Extra usage" }))
        .not.toBeInTheDocument();
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
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
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

  const codexAccountWith = (
    rateLimits: ReadonlyArray<CodexAccountRateLimit>,
  ): UsageAccounts[number] => {
    const [codexAccount] = accounts();
    return {
      ...codexAccount!,
      providerInstanceId: ProviderInstanceId.make("codex-test"),
      sections: [
        codexAccount!.sections[0]!,
        {
          ...codexAccount!.sections[1]!,
          snapshot: {
            fetchedAt: codex.fetchedAt,
            data: { rateLimits, resetCredits: { availableCount: 2, nextExpiresAt: null } },
          },
        },
      ],
    } as UsageAccounts[number];
  };

  it("names the tightest Codex window across groups and offers the reset there", async () => {
    // The shared fixture's resets are in the past; this test needs live windows.
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const exhausted = {
      ...codex.rateLimits[0]!,
      primary: { ...codex.rateLimits[0]!.primary, resetsAt: future },
      secondary: { ...codex.rateLimits[0]!.secondary, usedPercent: 100, resetsAt: future },
    };
    const spark = {
      ...codex.rateLimits[0]!,
      id: "codex_spark",
      name: "Spark",
      planType: null,
      primary: { ...codex.rateLimits[0]!.primary, resetsAt: future },
      secondary: null,
      credits: null,
    };
    const account = codexAccountWith([exhausted, spark]);
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <UsageDashboardView
          summary={summary()}
          accounts={[account]}
          range="7d"
          onRangeChange={() => {}}
          fetching={false}
        />
      </QueryClientProvider>,
    );
    try {
      const callout = page.getByTestId("tightest-limit");
      await expect.element(callout).toHaveTextContent(/0% left · Codex weekly limit/);
      await expect
        .element(callout.getByRole("button", { name: "Use reset credit (2)" }))
        .toBeVisible();
      expect(page.getByRole("button", { name: /reset credit/ }).all()).toHaveLength(1);
      // The plan shows in the account header and beside its limit group.
      await expect.element(page.getByText("plus", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText("Spark", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Credits: 12.50 · 2 limit resets available"))
        .toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Spark · 5-hour limit" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("skips an already-reset Codex window and names an unnamed group by its id", async () => {
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const stale = {
      ...codex.rateLimits[0]!,
      primary: { ...codex.rateLimits[0]!.primary, resetsAt: future },
      // Exhausted, but its reset passed before this render.
      secondary: { ...codex.rateLimits[0]!.secondary, usedPercent: 100 },
    };
    const unnamed = {
      ...codex.rateLimits[0]!,
      id: "codex_spark",
      name: null,
      planType: null,
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: future },
      secondary: null,
      credits: null,
    };
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <UsageDashboardView
          summary={summary()}
          accounts={[codexAccountWith([stale, unnamed])]}
          range="7d"
          onRangeChange={() => {}}
          fetching={false}
        />
      </QueryClientProvider>,
    );
    try {
      const callout = page.getByTestId("tightest-limit");
      await expect.element(callout).toHaveTextContent(/20% left · codex_spark 5-hour limit/);
      await expect.element(callout.getByRole("button")).not.toBeInTheDocument();
      // The reset button keeps its own row instead.
      expect(page.getByRole("button", { name: /reset credit/ }).all()).toHaveLength(1);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("does not name an already-reset Claude window as the tightest", async () => {
    const now = Date.now();
    const claude: UsageAccounts[number] = {
      key: "claude:stale",
      provider: "claudeAgent",
      providerInstanceId: null,
      displayName: "Claude",
      enabled: true,
      refreshState: "idle",
      sections: [
        {
          kind: "claude-usage",
          outcome: "available",
          lastAttemptAt: new Date(now - 60_000).toISOString(),
          errorCode: null,
          snapshot: {
            fetchedAt: new Date(now - 60_000).toISOString(),
            data: {
              subscriptionLabel: null,
              limitsAvailable: true,
              windows: [
                {
                  key: "five_hour",
                  label: "5-hour limit",
                  utilization: 100,
                  resetsAt: new Date(now - 30_000).toISOString(),
                },
                {
                  key: "seven_day",
                  label: "Weekly limit",
                  utilization: 40,
                  resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
                },
                {
                  key: "model:fable",
                  label: "Fable weekly limit",
                  utilization: 10,
                  resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
                },
              ],
              extraUsage: null,
            },
          },
        },
      ],
    };
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
        accounts={[claude]}
        range="7d"
        onRangeChange={() => {}}
        fetching={false}
      />,
    );
    try {
      await expect
        .element(page.getByTestId("tightest-limit"))
        .toHaveTextContent(/60% left · Weekly limit resets/);
      // The model-scoped weekly window gets a pace tick too; the expired one does not.
      expect(page.getByTestId("quota-pace-tick").all()).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });

  it("charts daily Codex tokens with the range highlighted and exact values on hover", async () => {
    const screen = await render(
      <UsageDashboardView
        summary={summary()}
        accounts={accounts()}
        range="7d"
        onRangeChange={() => {}}
        fetching={false}
      />,
    );
    try {
      await expect.element(page.getByTestId("daily-token-bars")).toBeInTheDocument();
      const bars = page.getByTestId("daily-token-bar");
      expect(bars.all()).toHaveLength(14);
      expect(
        bars.all().filter((bar) => bar.element().getAttribute("data-in-range") === "true"),
      ).toHaveLength(7);
      await userEvent.hover(bars.last());
      await expect.element(page.getByText("Aug 15 · 40,000 tokens")).toBeVisible();
      // The screen-reader table carries every day.
      await expect
        .element(page.getByRole("table", { name: "Daily account tokens (UTC)" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the usage analysis as one row per factor with both shares", async () => {
    const claude: UsageAccounts[number] = {
      key: "claude:analysis",
      provider: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claude-test"),
      displayName: "Claude",
      enabled: true,
      refreshState: "idle",
      sections: [],
      usageAnalysis: {
        analyzedAt: "2026-08-15T12:00:00.000Z",
        day: {
          requestCount: 1_742,
          sessionCount: 50,
          behaviors: [{ key: "long_context", pct: 69, count: 1 }],
          recommendations: [
            {
              key: "long_context",
              pct: 69,
              title: "Start fresh when you switch tasks",
              detail: "run /clear",
            },
          ],
        },
        week: {
          requestCount: 17_471,
          sessionCount: 395,
          behaviors: [
            { key: "long_context", pct: 69, count: 1 },
            { key: "cron", pct: 43, count: 1 },
          ],
          recommendations: [
            {
              key: "long_context",
              pct: 69,
              title: "Start fresh when you switch tasks",
              detail: "run /clear",
            },
          ],
        },
      },
    };
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <UsageDashboardView
          summary={summary()}
          accounts={[claude]}
          range="7d"
          onRangeChange={() => {}}
          fetching={false}
        />
      </QueryClientProvider>,
    );
    try {
      const table = page.getByRole("table", { name: "What drives usage" });
      await expect.element(table).toBeVisible();
      await expect.element(page.getByText("17,471 req · 395 sessions")).toBeVisible();
      const longContext = table.getByRole("row", { name: /Long context/ });
      await expect.element(longContext).toHaveTextContent(/24 hours: 69%.*7 days: 69%/);
      await expect.element(longContext).toHaveTextContent(/Start fresh when you switch tasks/);
      const scheduled = table.getByRole("row", { name: /Scheduled runs/ });
      await expect.element(scheduled).toHaveTextContent(/24 hours: none.*7 days: 43%/);
      await expect.element(scheduled).toHaveTextContent(/No recommendation/);
      expect(table.getByRole("row").all()).toHaveLength(3);
    } finally {
      await screen.unmount();
      queryClient.clear();
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

  const claudeGrant = (overrides: Partial<ClaudeLimitResetGrant> = {}): ClaudeLimitResetGrant => ({
    id: "full_reset",
    label: "Full reset",
    kind: "full",
    resetsLeft: 1,
    resetsTotal: 1,
    endsAt: "2026-12-10T22:00:00.000Z",
    usableNow: true,
    useRequiresLimit: false,
    givesBackWeekly: false,
    paused: false,
    clears: ["five_hour", "seven_day"],
    blocking: [],
    unavailableReason: null,
    ...overrides,
  });

  const claudeAccountWithResets = (fiveHourUsed: number): UsageAccounts[number] => {
    const { account } = claudeAccount();
    const section = account.sections[0] as Extract<
      UsageAccounts[number]["sections"][number],
      { kind: "claude-usage" }
    >;
    const future = new Date(Date.now() + 3_600_000).toISOString();
    return {
      ...account,
      providerInstanceId: ProviderInstanceId.make("claude-test"),
      sections: [
        {
          ...section,
          snapshot: {
            ...section.snapshot!,
            data: {
              ...section.snapshot!.data,
              windows: [
                {
                  key: "five_hour",
                  label: "5-hour limit",
                  utilization: fiveHourUsed,
                  resetsAt: future,
                },
                { key: "seven_day", label: "Weekly limit", utilization: 40, resetsAt: future },
              ],
              limitResets: {
                grants: [
                  claudeGrant(),
                  claudeGrant({
                    id: "fable_reset",
                    label: "Fable reset",
                    kind: "weekly",
                    resetsLeft: 2,
                    resetsTotal: 2,
                    usableNow: false,
                    useRequiresLimit: true,
                    givesBackWeekly: true,
                    clears: ["seven_day_overage_included"],
                    unavailableReason: "needs_limit",
                  }),
                  claudeGrant({ id: "spent", label: "Session reset", resetsLeft: 0 }),
                ],
                nextGrantId: "full_reset",
                cooldownUntil: null,
              },
            },
          },
        },
      ],
    };
  };

  it("offers one Claude limit-reset button per grant and moves the next one into the callout", async () => {
    const renderView = (account: UsageAccounts[number]) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <UsageDashboardView
            summary={summary()}
            accounts={[account]}
            range="7d"
            onRangeChange={() => {}}
            fetching={false}
          />
        </QueryClientProvider>,
      );
    let screen = await renderView(claudeAccountWithResets(100));
    try {
      const callout = page.getByTestId("tightest-limit");
      await expect.element(callout).toHaveTextContent(/0% left · 5-hour limit/);
      await expect
        .element(callout.getByRole("button", { name: "Use Full reset (1)" }))
        .toBeVisible();
      expect(page.getByRole("button", { name: /Full reset/ }).all()).toHaveLength(1);
      const group = page.getByRole("group", { name: "Limit resets" });
      await expect.element(group.getByText("Fable reset · 2")).toBeVisible();
      await expect.element(group.getByText(/Usable once you hit a limit/)).toBeVisible();
      await expect
        .element(group.getByRole("button", { name: "Use Fable reset (2)" }))
        .toBeDisabled();
      // A grant with no resets left is not offered.
      expect(page.getByText(/Session reset/).all()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }

    // Below the limit, the next grant keeps its own row.
    screen = await renderView(claudeAccountWithResets(40));
    try {
      await expect
        .element(page.getByTestId("tightest-limit").getByRole("button"))
        .not.toBeInTheDocument();
      const group = page.getByRole("group", { name: "Limit resets" });
      await expect.element(group.getByRole("button", { name: "Use Full reset (1)" })).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("claims the chosen Claude grant and reuses the key after an ambiguous failure", async () => {
    api.consumeResetCredit.mockReset();
    api.consumeResetCredit
      .mockRejectedValueOnce(new Error("lost connection"))
      .mockResolvedValue({ outcome: "reset" });
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ClaudeGrantButton
          instanceId={ProviderInstanceId.make("claude-test")}
          accountName="Claude"
          grant={claudeGrant({ givesBackWeekly: true })}
          cooldownUntil={null}
        />
      </QueryClientProvider>,
    );
    try {
      await page.getByRole("button", { name: "Use Full reset (1)" }).click();
      await expect.element(page.getByText("Use a Full reset?")).toBeVisible();
      await expect
        .element(
          page.getByText(
            /This uses one Full reset for Claude\. It clears the 5-hour limit and weekly limit\. It also gives back weekly usage\./,
          ),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "Confirm redemption" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("lost connection");
      await page.getByRole("button", { name: "Confirm redemption" }).click();
      await expect.poll(() => api.consumeResetCredit.mock.calls.length).toBe(2);
      const [first, second] = api.consumeResetCredit.mock.calls;
      expect(first).toEqual(second);
      expect(first![0]).toMatchObject({
        providerInstanceId: "claude-test",
        grantId: "full_reset",
      });
      expect(localStorage.getItem("f5:reset-credit:claude-test:full_reset")).toBeNull();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("formats a Claude cooldown's retry time in the viewer's locale", async () => {
    api.consumeResetCredit.mockReset();
    const retryAt = "2026-11-15T10:00:00.000Z";
    api.consumeResetCredit.mockResolvedValue({
      outcome: "unavailable",
      message: "Limit resets are cooling down.",
      retryAt,
    });
    const queryClient = new QueryClient();
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ClaudeGrantButton
          instanceId={ProviderInstanceId.make("claude-test")}
          accountName="Claude"
          grant={claudeGrant()}
          cooldownUntil={null}
        />
      </QueryClientProvider>,
    );
    try {
      await page.getByRole("button", { name: "Use Full reset (1)" }).click();
      await page.getByRole("button", { name: "Confirm redemption" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          `Limit resets are cooling down. Try again after ${new Date(retryAt).toLocaleString(
            undefined,
            { dateStyle: "medium", timeStyle: "short" },
          )}.`,
        );
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});

describe("unified page", () => {
  it("orders tabs Limits first, badges unpriced models and opens Pricing from the notice", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      const tabs = page.getByRole("tab");
      await expect.element(tabs.nth(0)).toHaveTextContent("Limits");
      await expect.element(tabs.nth(1)).toHaveTextContent("Activity");
      // Both fixture models have unpriced turns.
      await expect
        .element(page.getByRole("tab", { name: /Pricing/ }))
        .toHaveTextContent(/^Pricing2$/);
      // Limits at a glance is the first block on Activity.
      const activity = page.getByRole("region", { name: "Activity" });
      await expect
        .element(activity.getByRole("region").first())
        .toHaveAttribute("aria-label", "Limits at a glance");
      await page.getByRole("note", { name: "Unpriced models" }).getByRole("button").click();
      await expect
        .element(page.getByRole("tab", { name: /Pricing/ }))
        .toHaveAttribute("aria-selected", "true");
      const rows = page.getByRole("table", { name: "Model prices" }).getByRole("row");
      await expect.element(rows.nth(1)).toHaveTextContent(/Unpriced · 1/);
      await expect.element(rows.nth(2)).toHaveTextContent(/Unpriced · 1/);
      // Pricing reuses the Activity summary instead of requesting another.
      expect(api.getSummary).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("switches to Limits from the glance", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await page.getByRole("button", { name: "View details" }).click();
      await expect
        .element(page.getByRole("tab", { name: "Limits" }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("region", { name: "Account usage and limits" }))
        .toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("sorts a table from its header and filters threads by name", async () => {
    const screen = await renderWithRouter(
      <UsageDashboardView summary={scoped()} range="7d" fetching={false} />,
    );
    const models = () =>
      [
        ...[...document.querySelectorAll("table")]
          .find((table) => table.querySelector("caption")?.textContent === "Providers and models")!
          .querySelectorAll("tbody tr td:nth-child(2)"),
      ].map((cell) => cell.textContent);
    try {
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
      expect(models()).toEqual(["gpt-5.6", "cursor-agent"]);
      const tokens = page
        .getByRole("table", { name: "Providers and models" })
        .getByRole("columnheader", { name: /Tokens/ });
      await expect.element(tokens).toHaveAttribute("aria-sort", "descending");
      await tokens.getByRole("button").click();
      await expect.element(tokens).toHaveAttribute("aria-sort", "ascending");
      expect(models()).toEqual(["cursor-agent", "gpt-5.6"]);

      await page.getByRole("button", { name: "Threads" }).click();
      await page.getByLabelText("Filter by name").fill("fix");
      const threads = page.getByRole("table", { name: "Threads" }).getByRole("row");
      expect(threads.all()).toHaveLength(2);
      await expect.element(threads.nth(1)).toHaveTextContent(/Fix bug/);
      await page.getByLabelText("Filter by name").fill("zzz");
      await expect.element(page.getByText("No threads match “zzz”.")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("sorts every project before trimming and searches past the top threads", async () => {
    const base = scoped();
    const many = Array.from({ length: 12 }, (_, index) => ({
      projectId: ProjectId.makeUnsafe(`project-${index + 1}`),
      title: `Project ${index + 1}`,
      deleted: false,
      metrics: metrics({ totalTokens: (12 - index) * 100 }),
    }));
    const threads = Array.from({ length: 12 }, (_, index) => ({
      threadId: ThreadId.makeUnsafe(`thread-${index + 1}`),
      projectId: many[0]!.projectId,
      title: `Thread ${index + 1}`,
      deleted: false,
      metrics: metrics({ totalTokens: (12 - index) * 100 }),
    }));
    const screen = await renderWithRouter(
      <UsageDashboardView
        summary={{
          ...base,
          projectScope: {
            ...base.projectScope!,
            byProject: many,
            topThreads: threads,
            threadCount: 12,
          },
        }}
        range="7d"
        fetching={false}
      />,
    );
    const firstName = (caption: string) =>
      [...document.querySelectorAll("table")]
        .find((table) => table.querySelector("caption")?.textContent === caption)!
        .querySelector("tbody tr td")?.textContent;
    try {
      const projects = page.getByRole("table", { name: "Projects" });
      await expect.element(projects).toBeVisible();
      expect(projects.getByRole("row").all()).toHaveLength(11);
      expect(firstName("Projects")).toBe("Project 1");
      await projects
        .getByRole("columnheader", { name: /Known tokens/ })
        .getByRole("button")
        .click();
      // Ascending reaches the lowest projects, which were outside the first ten.
      expect(firstName("Projects")).toBe("Project 12");

      await page.getByRole("button", { name: "Threads" }).click();
      await page.getByLabelText("Filter by name").fill("thread 12");
      await expect
        .element(page.getByRole("table", { name: "Threads" }))
        .toHaveTextContent("Thread 12");
      await expect.element(page.getByText("Search covers the top 12 of 12 threads.")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Activity on screen while turning Compare on", async () => {
    api.getSummary.mockImplementation((input: { includePreviousBuckets?: boolean }) =>
      input.includePreviousBuckets ? new Promise(() => {}) : Promise.resolve(scoped()),
    );
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      const compare = page.getByRole("button", { name: "Compare to previous period" });
      await expect.element(compare).toBeVisible();
      await compare.click();
      await vi.waitFor(() =>
        expect(api.getSummary).toHaveBeenCalledWith(
          expect.objectContaining({ includePreviousBuckets: true }),
          expect.anything(),
        ),
      );
      await expect.element(compare).toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByRole("heading", { name: "Usage over time" })).toBeVisible();
      await expect.element(page.getByText("Projects and threads")).toBeVisible();
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("exports a breakdown as a dated CSV", async () => {
    api.getSummary.mockResolvedValue(summary());
    api.getAccounts.mockResolvedValue(accounts());
    const downloads: Array<string> = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await page.getByRole("button", { name: "Export usage" }).click();
      await page.getByRole("menuitem", { name: "Providers and models (CSV)" }).click();
      expect(downloads).toHaveLength(1);
      expect(downloads[0]).toMatch(/^f5-usage-7d-models-\d{4}-\d{2}-\d{2}\.csv$/);
    } finally {
      click.mockRestore();
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("requests and draws the previous period when comparing", async () => {
    api.getSummary.mockResolvedValue(
      summary({
        previousBuckets: [
          { key: "2026-08-07", startAt: "2026-08-07T00:00:00.000Z", metrics: metrics() },
          { key: "2026-08-08", startAt: "2026-08-08T00:00:00.000Z", metrics: metrics() },
        ],
      }),
    );
    api.getAccounts.mockResolvedValue(accounts());
    const onSearchChange = vi.fn();
    const queryClient = client();
    const screen = await renderDashboard(
      queryClient,
      <UsageDashboard search={{ compare: true }} onSearchChange={onSearchChange} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Compare to previous period" }))
        .toHaveAttribute("aria-pressed", "true");
      expect(api.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({ includePreviousBuckets: true }),
        expect.anything(),
      );
      expect(page.getByTestId("usage-chart-previous").all()).toHaveLength(2);
      await page.getByRole("button", { name: "Compare to previous period" }).click();
      expect(onSearchChange).toHaveBeenLastCalledWith({ compare: undefined });
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });

  it("meters the monthly budget and warns once it is exceeded", async () => {
    (settings.current as Record<string, unknown>).usageMonthlyBudget = {
      costUsd: 10,
      tokens: null,
    };
    const today = new Date().toISOString().slice(0, 10);
    api.getSummary.mockImplementation(async (input: { range: string }) =>
      input.range === "90d"
        ? summary({
            range: "90d",
            generatedAt: new Date().toISOString(),
            buckets: [bucket(today, { metrics: metrics({ providerReportedCostUsd: 50 }) })],
          })
        : summary(),
    );
    api.getAccounts.mockResolvedValue(accounts());
    const queryClient = client();
    const screen = await renderDashboard(queryClient);
    try {
      await expect.element(page.getByText("Monthly budget exceeded")).toBeVisible();
      await expect
        .element(page.getByRole("progressbar", { name: "Cost budget" }))
        .toHaveAttribute("aria-valuetext", "500% used");
      // The budget covers everything: no provider or project filter.
      expect(api.getSummary).toHaveBeenCalledWith(
        expect.not.objectContaining({ hiddenProviders: expect.anything() }),
        expect.anything(),
      );
    } finally {
      await screen.unmount();
      queryClient.clear();
    }
  });
});
