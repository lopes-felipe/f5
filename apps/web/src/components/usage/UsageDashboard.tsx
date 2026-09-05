import type {
  UsageAccounts,
  AccountUsageErrorCode,
  ProviderKind,
  CodexAccountRateLimitWindow,
  CodexAccountUsage,
  UsageMetrics,
  UsageRange,
  UsageSummary,
} from "@t3tools/contracts";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { AlertTriangleIcon, CoinsIcon, GaugeIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";

import { useMemo, useState } from "react";

import {
  accountJobsPending,
  decodeUsageAccounts,
  usageAccountsQueryOptions,
  usageQueryKeys,
  usageSummaryQueryOptions,
} from "../../lib/usageReactQuery";

import { ensureNativeApi } from "../../nativeApi";

import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";

import { QuotaMeter } from "./charts/QuotaMeter";

import { StackedBarChart } from "./charts/StackedBarChart";

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

function CodexRateLimitWindowView(props: {
  readonly window: CodexAccountRateLimitWindow;

  readonly fallbackLabel: string;
}) {
  const label = rateLimitWindowLabel(props.window, props.fallbackLabel);

  const milliseconds = props.window.resetsAt === null ? NaN : props.window.resetsAt * 1000;

  const resetsAt = Number.isFinite(new Date(milliseconds).getTime())
    ? new Date(milliseconds).toISOString()
    : null;

  return (
    <QuotaMeter
      label={label}
      accessibleName={`Codex · ${label}`}
      utilization={props.window.usedPercent}
      resetsAt={resetsAt}
    />
  );
}

function codexAccountRangeTokens(input: {
  readonly usage: CodexAccountUsage;

  readonly range: UsageRange;
}): string | null {
  const rangeDays = input.range === "24h" ? 1 : Number.parseInt(input.range, 10);

  const firstDay = new Date(input.usage.fetchedAt);

  firstDay.setUTCHours(0, 0, 0, 0);

  firstDay.setUTCDate(firstDay.getUTCDate() - (rangeDays - 1));

  const firstDate = firstDay.toISOString().slice(0, 10);

  let total = 0n;

  let found = false;

  for (const bucket of input.usage.dailyUsageBuckets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)) continue;

    const date = new Date(`${bucket.startDate}T00:00:00.000Z`);

    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== bucket.startDate)
      continue;

    if (bucket.startDate < firstDate || bucket.startDate > input.usage.fetchedAt.slice(0, 10))
      continue;

    total += BigInt(bucket.tokens);

    found = true;
  }

  return found ? total.toString() : null;
}

function CodexAccountUsageSection(props: {
  readonly usage: CodexAccountUsage;

  readonly range: UsageRange;
}) {
  const { usage } = props;

  const summary = usage.tokenSummary;

  const rangeTokens = codexAccountRangeTokens(props);

  return (
    <div className="space-y-4 pt-2">
      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-[11px] text-muted-foreground">
              Account tokens ·{" "}
              {props.range === "24h" ? "Today (UTC)" : `${props.range} (UTC calendar days)`}
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
                  Credits: {limit.credits.unlimited ? "Unlimited" : (limit.credits.balance ?? "—")}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
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

const ACCOUNT_ERROR_MESSAGES: Record<AccountUsageErrorCode, string> = {
  unsupported: "This installed provider version does not expose account usage and rate limits.",

  "authentication-required": "Account usage requires authentication in provider settings.",

  timeout: "The account usage request timed out.",

  "process-unavailable": "The configured provider executable is unavailable.",

  "invalid-response": "The provider returned an invalid account usage response.",

  "temporary-failure": "Account usage is temporarily unavailable.",
};

function AccountUsageCards({ accounts, range }: { accounts: UsageAccounts; range: UsageRange }) {
  return (
    <section aria-label="Account usage and limits" className="space-y-3">
      <h2 className="text-sm font-medium">Account usage and limits</h2>
      {accounts.map((account) => (
        <div key={account.key} className="space-y-2 rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{account.displayName}</h3>
            <span role="status" className="text-xs text-muted-foreground">
              {account.refreshState === "idle"
                ? ""
                : account.refreshState === "queued"
                  ? "Queued"
                  : "Refreshing…"}
            </span>
          </div>
          {account.provider === "codex" && (
            <p className="text-xs text-muted-foreground">
              Provider-native ChatGPT/Codex account totals and quota windows. These are not dollar
              costs.
            </p>
          )}
          {account.provider === "claudeAgent" && (
            <p className="text-xs text-muted-foreground">
              Configured instance's server-default authentication context.
            </p>
          )}
          {!account.enabled ? (
            <p className="text-xs text-muted-foreground">
              {providerLabel(account.provider)} is disabled in provider settings.
            </p>
          ) : (
            account.sections.map((section) => (
              <div key={section.kind} className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {section.kind === "codex-tokens"
                    ? "Token history · "
                    : section.kind === "codex-limits"
                      ? "Rate limits · "
                      : ""}
                  {section.snapshot
                    ? `Updated ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}`
                    : "No successful snapshot yet"}
                </p>
                {section.outcome !== "available" &&
                  (section.lastAttemptAt || section.errorCode) && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {section.outcome === "unsupported"
                        ? `This installed ${providerLabel(account.provider)} version does not expose account usage and rate limits.`
                        : ACCOUNT_ERROR_MESSAGES[section.errorCode ?? "temporary-failure"]}
                      {section.snapshot
                        ? ` Showing data from ${formatAbsoluteTimeLabel(section.snapshot.fetchedAt)}.`
                        : ""}
                    </p>
                  )}
                {section.kind === "claude-usage" && section.snapshot && (
                  <div className="space-y-3">
                    {section.snapshot.data.subscriptionLabel && (
                      <p className="text-xs font-medium">
                        {section.snapshot.data.subscriptionLabel}
                      </p>
                    )}
                    {!section.snapshot.data.limitsAvailable ? (
                      <p className="text-xs text-muted-foreground">
                        Plan limits aren't reported for this Claude session.
                      </p>
                    ) : section.snapshot.data.windows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Account usage is temporarily unavailable.
                      </p>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-2">
                        {section.snapshot.data.windows.map((window) => (
                          <QuotaMeter
                            key={window.key}
                            label={window.label}
                            utilization={window.utilization}
                            resetsAt={window.resetsAt}
                            accessibleName={`${account.displayName} · ${window.label}`}
                          />
                        ))}
                      </div>
                    )}
                    {section.snapshot.data.extraUsage && (
                      <div className="space-y-2">
                        <p className="text-xs">
                          Extra usage{" "}
                          {section.snapshot.data.extraUsage.enabled ? "enabled" : "disabled"}
                        </p>
                        {section.snapshot.data.extraUsage.enabled && (
                          <QuotaMeter
                            label="Extra usage"
                            accessibleName={`${account.displayName} · Extra usage`}
                            utilization={section.snapshot.data.extraUsage.utilization}
                            resetsAt={null}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
                {section.kind === "codex-tokens" && section.snapshot && (
                  <CodexAccountUsageSection
                    range={range}
                    usage={{
                      ...section.snapshot.data,

                      status: "available",

                      fetchedAt: section.snapshot.fetchedAt,

                      rateLimits: [],

                      message: null,
                    }}
                  />
                )}
                {section.kind === "codex-limits" && section.snapshot && (
                  <CodexAccountUsageSection
                    range={range}
                    usage={{
                      ...section.snapshot.data,

                      status: "available",

                      fetchedAt: section.snapshot.fetchedAt,

                      tokenSummary: null,

                      dailyUsageBuckets: [],

                      message: null,
                    }}
                  />
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </section>
  );
}

export function UsageDashboardView(props: {
  readonly summary: UsageSummary;

  readonly range: UsageRange;

  readonly onRangeChange: (range: UsageRange) => void;

  readonly fetching: boolean;

  readonly accounts?: UsageAccounts | undefined;

  readonly provider?: ProviderKind | undefined;

  readonly onProviderChange?: (provider: ProviderKind | undefined) => void;

  readonly onRefresh?: () => void;

  readonly error?: string | null;

  readonly onDismissError?: () => void;

  readonly renderAccounts?: boolean;

  readonly refreshNotice?: string | null;
}) {
  const { summary } = props;

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
            <Button
              size="xs"
              variant="outline"
              aria-label="Refresh usage"
              disabled={props.fetching}
              onClick={props.onRefresh}
            >
              <RefreshCwIcon
                aria-hidden="true"
                className={cn("size-3.5", props.fetching && "animate-spin")}
              />
              Refresh
            </Button>
            <span className="text-xs text-muted-foreground" title={summary.generatedAt}>
              Updated {formatAbsoluteTimeLabel(summary.generatedAt)}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Historical provider-reported tokens and API-equivalent cost, plus account usage and
            limits. Subscription or invoice spend may differ.
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
      {props.error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs"
        >
          <span>
            {props.error} Last successful history update:{" "}
            {formatAbsoluteTimeLabel(summary.generatedAt)}.
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Dismiss refresh error"
            onClick={props.onDismissError}
          >
            Dismiss
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">F5 activity</h2>
        <select
          aria-label="History provider"
          className="rounded-md border border-border bg-background p-1 text-xs"
          value={props.provider ?? "all"}
          onChange={(event) =>
            props.onProviderChange?.(
              event.target.value === "all" ? undefined : (event.target.value as ProviderKind),
            )
          }
        >
          <option value="all">All providers</option>
          {(["codex", "claudeAgent", "cursor", "opencode", "grok"] as const).map((provider) => (
            <option key={provider} value={provider}>
              {providerLabel(provider)}
            </option>
          ))}
        </select>
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
      <Card className="rounded-xl">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Token usage over time</CardTitle>
        </CardHeader>
        <CardPanel className="p-4 pt-2">
          <StackedBarChart
            buckets={summary.buckets}
            label={`Token usage chart for ${RANGES.find((option) => option.value === props.range)?.label}`}
            timeZone={summary.timeZone}
          />
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
                  <th className="px-4 py-2 font-medium">Thread model</th>
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
                    F5 token recording began {coverageDate}. Earlier provider-reported costs are
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
      <p className="text-xs text-muted-foreground">
        Claude history uses reported main-agent token fields. SDK-reported cost estimates can cover
        a broader scope and are not billing data.
      </p>
      {props.refreshNotice && (
        <p role="status" className="text-xs text-muted-foreground">
          {props.refreshNotice}
        </p>
      )}
      {props.renderAccounts !== false && props.accounts && (
        <AccountUsageCards accounts={props.accounts} range={props.range} />
      )}
    </div>
  );
}

export function UsageDashboard() {
  const [range, setRange] = useState<UsageRange>("7d");

  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const [provider, setProvider] = useState<ProviderKind>();

  const [refreshing, setRefreshing] = useState(false);

  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);

  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [dismissedErrorAt, setDismissedErrorAt] = useState(0);

  const queryClient = useQueryClient();

  const summaryQuery = useQuery(usageSummaryQueryOptions(range, timeZone, provider));

  const accountsQuery = useQuery(usageAccountsQueryOptions());

  const jobsPending = accountJobsPending(accountsQuery.data);

  const refresh = async () => {
    if (refreshing || jobsPending) return;

    setRefreshing(true);

    setRefreshError(null);

    setRefreshNotice(null);

    const errors: string[] = [];

    try {
      const result = await summaryQuery.refetch();

      if (result.error) errors.push("Historical usage refresh failed.");
    } catch {
      errors.push("Historical usage refresh failed.");
    }

    try {
      const accounts = decodeUsageAccounts(
        await ensureNativeApi().usage.getAccounts({ refresh: "force" }),
      );

      if (
        !accountJobsPending(accounts) &&
        accounts.some((account) => account.enabled) &&
        accounts.every(
          (account) =>
            JSON.stringify(account.sections) ===
            JSON.stringify(
              accountsQuery.data?.find((prior) => prior.key === account.key)?.sections,
            ),
        )
      ) {
        setRefreshNotice(
          "No new account refresh was scheduled. Refreshes have a 30-second minimum interval.",
        );
      }

      queryClient.setQueryData(usageQueryKeys.accounts, accounts);
    } catch {
      errors.push("Account usage refresh failed. Please retry.");
    } finally {
      setRefreshError(errors.length ? errors.join(" ") : null);

      setRefreshing(false);
    }
  };

  let history;

  if (summaryQuery.isPending) {
    history = (
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
  } else if (!summaryQuery.data) {
    history = (
      <div className="flex items-center justify-center p-6">
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
  } else {
    history = (
      <UsageDashboardView
        summary={summaryQuery.data}
        range={range}
        onRangeChange={setRange}
        fetching={summaryQuery.isFetching || refreshing || jobsPending}
        renderAccounts={false}
        refreshNotice={refreshNotice}
        provider={provider}
        onProviderChange={setProvider}
        onRefresh={() => {
          void refresh();
        }}
        error={
          refreshError ??
          (summaryQuery.isError && summaryQuery.errorUpdatedAt > dismissedErrorAt
            ? "Historical usage refresh failed."
            : accountsQuery.isError && accountsQuery.errorUpdatedAt > dismissedErrorAt
              ? "Account snapshots could not be refreshed."
              : null)
        }
        onDismissError={() => {
          setRefreshError(null);

          setDismissedErrorAt(Date.now());
        }}
      />
    );
  }

  return (
    <>
      {history}
      <div className="mx-auto w-full max-w-6xl space-y-3 px-4 pb-6 sm:px-6">
        {accountsQuery.isPending ? (
          <div role="status" aria-label="Loading account usage">
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : null}
        {accountsQuery.isError &&
          !summaryQuery.data &&
          accountsQuery.errorUpdatedAt > dismissedErrorAt && (
            <p role="alert" className="text-xs text-muted-foreground">
              Account snapshots could not be refreshed.
            </p>
          )}
        {accountsQuery.data && <AccountUsageCards accounts={accountsQuery.data} range={range} />}
      </div>
    </>
  );
}
