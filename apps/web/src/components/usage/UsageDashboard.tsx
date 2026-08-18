import type {
  CodexAccountRateLimitWindow,
  CodexAccountUsage,
  UsageMetrics,
  UsageRange,
  UsageSummary,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CoinsIcon, GaugeIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { usageSummaryQueryOptions } from "../../lib/usageReactQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";

const RANGES: ReadonlyArray<{ readonly value: UsageRange; readonly label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function compactDecimalCount(value: string | null): string {
  if (value === null) return "Unavailable";
  try {
    return new Intl.NumberFormat(undefined, {
      notation: value.length > 4 ? "compact" : "standard",
      maximumFractionDigits: value.length > 4 ? 1 : 0,
    }).format(BigInt(value));
  } catch {
    return value;
  }
}

function rateLimitWindowLabel(window: CodexAccountRateLimitWindow, fallback: string): string {
  const minutes = window.windowDurationMins;
  if (minutes === null) return fallback;
  if (minutes === 300) return "5-hour limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

function resetLabel(resetsAt: number | null): string {
  if (resetsAt === null) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(resetsAt * 1_000))}`;
}

function CodexRateLimitWindowView(props: {
  readonly window: CodexAccountRateLimitWindow;
  readonly fallbackLabel: string;
}) {
  const percent = Math.min(100, props.window.usedPercent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">
          {rateLimitWindowLabel(props.window, props.fallbackLabel)}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {props.window.usedPercent.toFixed(0)}% used
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={rateLimitWindowLabel(props.window, props.fallbackLabel)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            percent >= 90 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{resetLabel(props.window.resetsAt)}</p>
    </div>
  );
}

function codexAccountRangeTokens(input: {
  readonly usage: CodexAccountUsage;
  readonly range: UsageRange;
  readonly generatedAt: string;
}): string | null {
  const rangeDays = input.range === "24h" ? 1 : Number.parseInt(input.range, 10);
  const firstDay = new Date(input.generatedAt);
  firstDay.setUTCHours(0, 0, 0, 0);
  firstDay.setUTCDate(firstDay.getUTCDate() - (rangeDays - 1));
  const firstDate = firstDay.toISOString().slice(0, 10);
  let total = 0n;
  let found = false;
  for (const bucket of input.usage.dailyUsageBuckets) {
    if (bucket.startDate < firstDate) continue;
    total += BigInt(bucket.tokens);
    found = true;
  }
  return found ? total.toString() : null;
}

function CodexAccountUsageCard(props: {
  readonly usage: CodexAccountUsage;
  readonly range: UsageRange;
  readonly generatedAt: string;
}) {
  const { usage } = props;
  const summary = usage.tokenSummary;
  const rangeTokens = codexAccountRangeTokens(props);
  if (usage.status !== "available") {
    return (
      <Card className="rounded-xl">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Codex account usage</CardTitle>
        </CardHeader>
        <CardPanel className="p-4 pt-1 text-xs text-muted-foreground">
          {usage.status === "unsupported"
            ? "This installed Codex version does not expose account usage and rate limits."
            : "Codex account usage is temporarily unavailable."}
          {usage.message ? <p className="mt-1 break-words opacity-80">{usage.message}</p> : null}
        </CardPanel>
      </Card>
    );
  }

  return (
    <Card className="rounded-xl">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Codex account usage</CardTitle>
        <p className="text-xs text-muted-foreground">
          Provider-native ChatGPT/Codex account totals and quota windows. These are not dollar
          costs.
        </p>
      </CardHeader>
      <CardPanel className="space-y-4 p-4 pt-2">
        {summary ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-[11px] text-muted-foreground">
                Account tokens · {props.range === "24h" ? "today" : props.range}
              </p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">
                {compactDecimalCount(rangeTokens)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Lifetime tokens</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">
                {compactDecimalCount(summary.lifetimeTokens)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Peak daily tokens</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">
                {compactDecimalCount(summary.peakDailyTokens)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">Current usage streak</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">
                {summary.currentStreakDays === null
                  ? "Unavailable"
                  : `${summary.currentStreakDays} day${summary.currentStreakDays === "1" ? "" : "s"}`}
              </p>
            </div>
          </div>
        ) : null}

        {usage.rateLimits.length > 0 ? (
          <div className="grid gap-4 border-t border-border/60 pt-4 md:grid-cols-2">
            {usage.rateLimits.map((limit) => (
              <div key={limit.id} className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{limit.name ?? limit.id}</p>
                  {limit.planType ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {limit.planType}
                    </span>
                  ) : null}
                </div>
                {limit.primary ? (
                  <CodexRateLimitWindowView window={limit.primary} fallbackLabel="Primary limit" />
                ) : null}
                {limit.secondary ? (
                  <CodexRateLimitWindowView
                    window={limit.secondary}
                    fallbackLabel="Secondary limit"
                  />
                ) : null}
                {limit.credits?.hasCredits ? (
                  <p className="text-[11px] text-muted-foreground">
                    Credits:{" "}
                    {limit.credits.unlimited ? "Unlimited" : (limit.credits.balance ?? "—")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardPanel>
    </Card>
  );
}

function costLabel(metrics: UsageMetrics): string {
  if (metrics.providerReportedCostUsd === null) return "Unreported";
  const formatted = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(metrics.providerReportedCostUsd);
  return metrics.unpricedTurnCount > 0 ? `${formatted} + unreported` : formatted;
}

function providerLabel(provider: UsageSummary["byProvider"][number]["provider"]): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
  }
}

function MetricCard(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly icon: typeof GaugeIcon;
}) {
  const Icon = props.icon;
  return (
    <Card className="rounded-xl">
      <CardPanel className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon aria-hidden="true" className="size-3.5" />
          {props.label}
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
          {props.value}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">{props.detail}</p>
      </CardPanel>
    </Card>
  );
}

export function UsageDashboardView(props: {
  readonly summary: UsageSummary;
  readonly range: UsageRange;
  readonly onRangeChange: (range: UsageRange) => void;
  readonly fetching: boolean;
}) {
  const { summary } = props;
  const maxTokens = Math.max(0, ...summary.buckets.map((bucket) => bucket.metrics.totalTokens));
  const coverageDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(summary.coverage.coverageStartedAt));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
            {props.fetching ? (
              <RefreshCwIcon
                aria-label="Refreshing"
                className="size-3.5 animate-spin text-muted-foreground"
              />
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Historical provider-reported tokens and API-equivalent cost, plus Codex account usage
            and limits. Subscription or invoice spend may differ.
          </p>
        </div>
        <div
          aria-label="Usage range"
          className="flex rounded-lg border border-border bg-muted/30 p-0.5"
        >
          {RANGES.map((option) => (
            <Button
              key={option.value}
              size="xs"
              variant={props.range === option.value ? "secondary" : "ghost"}
              aria-pressed={props.range === option.value}
              onClick={() => props.onRangeChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total tokens"
          value={compactNumber(summary.metrics.totalTokens)}
          detail={`${summary.metrics.reportedTokenTurnCount} of ${summary.metrics.turnCount} turns reported tokens`}
          icon={SigmaIcon}
        />
        <MetricCard
          label="Input / output"
          value={`${compactNumber(summary.metrics.inputTokens)} / ${compactNumber(summary.metrics.outputTokens)}`}
          detail="Provider-native fields; cache semantics can differ"
          icon={GaugeIcon}
        />
        <MetricCard
          label="Cache read / write"
          value={`${compactNumber(summary.metrics.cacheReadTokens)} / ${compactNumber(summary.metrics.cacheWriteTokens)}`}
          detail="Reported cache token fields only"
          icon={RefreshCwIcon}
        />
        <MetricCard
          label="Reported cost"
          value={costLabel(summary.metrics)}
          detail={`${summary.metrics.pricedTurnCount} priced · ${summary.metrics.unpricedTurnCount} unreported`}
          icon={CoinsIcon}
        />
      </div>

      {summary.codexAccount ? (
        <CodexAccountUsageCard
          usage={summary.codexAccount}
          range={props.range}
          generatedAt={summary.generatedAt}
        />
      ) : null}

      <Card className="rounded-xl">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Token usage over time</CardTitle>
        </CardHeader>
        <CardPanel className="p-4 pt-2">
          {maxTokens === 0 ? (
            <div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              No token totals were reported in this range.
            </div>
          ) : (
            <div
              role="img"
              aria-label={`Token usage chart for ${RANGES.find((option) => option.value === props.range)?.label}`}
              className="flex h-52 items-end gap-1 overflow-hidden rounded-lg border border-border/70 bg-muted/20 px-2 pt-4 pb-2"
            >
              {summary.buckets.map((bucket, index) => {
                const height = Math.max(2, (bucket.metrics.totalTokens / maxTokens) * 100);
                const showLabel =
                  summary.buckets.length <= 24 ||
                  index === 0 ||
                  index === summary.buckets.length - 1 ||
                  index % Math.ceil(summary.buckets.length / 8) === 0;
                return (
                  <div
                    key={bucket.key}
                    className="group flex min-w-0 flex-1 flex-col items-center justify-end self-stretch"
                    title={`${bucket.label}: ${bucket.metrics.totalTokens.toLocaleString()} tokens`}
                  >
                    <div className="relative flex w-full flex-1 items-end">
                      <div
                        className="w-full min-w-0 rounded-t-sm bg-primary/70 transition-colors group-hover:bg-primary"
                        style={{ height: `${height}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "mt-1 h-4 max-w-full truncate text-[9px] text-muted-foreground",
                        !showLabel && "invisible",
                      )}
                    >
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardPanel>
      </Card>

      <Card className="rounded-xl">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Providers and models</CardTitle>
        </CardHeader>
        <CardPanel className="overflow-x-auto p-0">
          {summary.byProvider.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No completed turns in this range.</p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-y border-border/70 bg-muted/20 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 text-right font-medium">Turns</th>
                  <th className="px-4 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">Reported cost</th>
                </tr>
              </thead>
              <tbody>
                {summary.byProvider.map((entry) => (
                  <tr
                    key={`${entry.provider}:${entry.model ?? "legacy"}`}
                    className="border-b border-border/50 last:border-b-0"
                  >
                    <td className="px-4 py-2.5 font-medium text-foreground">
                      {providerLabel(entry.provider)}
                    </td>
                    <td className="max-w-72 truncate px-4 py-2.5 font-mono text-muted-foreground">
                      {entry.model ?? "Unavailable for historical cost"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {entry.metrics.turnCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {entry.metrics.reportedTokenTurnCount > 0
                        ? compactNumber(entry.metrics.totalTokens)
                        : "Unreported"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {costLabel(entry.metrics)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardPanel>
      </Card>

      {summary.coverage.partialHistory ||
      summary.coverage.tokenUnreportedTurnCount > 0 ||
      summary.coverage.costUnreportedTurnCount > 0 ? (
        <section
          aria-label="Usage coverage"
          className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"
        >
          <div className="flex items-start gap-2">
            <AlertTriangleIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <div className="text-xs leading-relaxed">
              <p className="font-medium text-foreground">Coverage and provider reporting</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {summary.coverage.partialHistory ? (
                  <li>
                    Token coverage starts {coverageDate}. Earlier provider-reported costs are
                    included where available, but earlier token history is incomplete.
                  </li>
                ) : null}
                {summary.coverage.providersMissingTokens.length > 0 ? (
                  <li>
                    Token fields were unreported for{" "}
                    {summary.coverage.providersMissingTokens.map(providerLabel).join(", ")}.
                  </li>
                ) : null}
                {summary.coverage.providersMissingCost.length > 0 ? (
                  <li>
                    Cost was unreported for{" "}
                    {summary.coverage.providersMissingCost.map(providerLabel).join(", ")}; no price
                    was estimated.
                  </li>
                ) : null}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function UsageDashboard() {
  const [range, setRange] = useState<UsageRange>("7d");
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const summaryQuery = useQuery(usageSummaryQueryOptions(range, timeZone));

  if (summaryQuery.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 sm:px-6">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertTriangleIcon aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
          <h1 className="mt-3 text-base font-medium">Usage is unavailable</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The server could not aggregate the requested usage range.
          </p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void summaryQuery.refetch()}
          >
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <UsageDashboardView
      summary={summaryQuery.data}
      range={range}
      onRangeChange={setRange}
      fetching={summaryQuery.isFetching}
    />
  );
}
