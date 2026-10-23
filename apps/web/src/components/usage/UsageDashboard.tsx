import {
  type ProjectId,
  type ProviderKind,
  type UsageAccounts,
  type UsageMetrics,
  type UsageRange,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  onlineManager,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AlertTriangleIcon, CoinsIcon, GaugeIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useServerKeybindings } from "../../keybindings";
import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import {
  accountJobsPending,
  forceRefreshUsageAccounts,
  refreshUsageSummaries,
  USAGE_ACCOUNTS_FORCE_MUTATION_KEY,
  usageAccountsQueryOptions,
  usageQueryKeys,
  usageQuotaHistoryQueryOptions,
  usageSummaryQueryOptions,
} from "../../lib/usageReactQuery";
import type { UsageMetric, UsageSearchPatch, UsageTab } from "../../lib/usageSearch";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useWsConnectionState } from "../../wsConnectionState";
import { Button } from "../ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { AccountUsageCards, indexQuotaHistory } from "./AccountUsageCards";
import { StackedBarChart } from "./charts/StackedBarChart";
import {
  cacheRateText,
  costDelta,
  costLabel,
  providerLabel,
  RANGES,
  rangeLabel,
  recordCountDisplay,
  resolveUsageTimeZone,
  tokenDelta,
  tokenFieldDisplay,
  usageMetricValue,
} from "./format";
import { ProjectsThreadsCard } from "./ProjectsThreadsCard";
import { UsageProviderFilter } from "./UsageProviderFilter";
import { isUsageBackShortcut, resolveUsageShortcut } from "./usageShortcuts";
import { UsagePriceEditor, type UsagePriceDraft } from "./UsagePriceEditor";

export type { UsageSearch, UsageSearchPatch, UsageTab } from "../../lib/usageSearch";

const METRICS: ReadonlyArray<{ readonly value: UsageMetric; readonly label: string }> = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
  { value: "turns", label: "Recorded turns" },
];

const CHART_LABELS: Record<UsageMetric, string> = {
  tokens: "Token usage chart",
  cost: "Cost chart",
  turns: "Recorded turns chart",
};

/** Ranks provider and model rows by the selected metric, then by tokens. */
function sortByMetric<Entry extends { readonly metrics: UsageMetrics }>(
  entries: ReadonlyArray<Entry>,
  metric: UsageMetric,
): Array<Entry> {
  return [...entries].sort(
    (left, right) =>
      usageMetricValue(right.metrics, metric) - usageMetricValue(left.metrics, metric) ||
      right.metrics.totalTokens - left.metrics.totalTokens,
  );
}

// Each refresh rebuilds the summary server-side (several SQLite passes), so
// streaming turns refresh at most every 5 seconds.
const EVENT_THROTTLE_MS = 5_000;

function MetricCard(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: ReactNode;
  readonly icon: typeof GaugeIcon;
  readonly delta?: string | null;
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
        <p className="mt-1 text-2xs text-muted-foreground">{props.detail}</p>
        {props.delta ? (
          <p className="mt-0.5 text-2xs text-muted-foreground">{props.delta}</p>
        ) : null}
      </CardPanel>
    </Card>
  );
}

function SegmentedControl<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="flex rounded-lg border border-border bg-muted/30 p-0.5"
    >
      {props.options.map((option) => (
        <Button
          key={option.value}
          size="xs"
          variant={props.value === option.value ? "secondary" : "ghost"}
          aria-pressed={props.value === option.value}
          disabled={option.disabled}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function UsageHeader(props: {
  readonly range: UsageRange;
  readonly onRangeChange: (range: UsageRange) => void;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
          {props.actions}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Historical provider-reported tokens and API-equivalent cost, plus account usage and
          limits. Subscription or invoice spend may differ.
        </p>
      </div>
      <SegmentedControl
        label="Usage range"
        value={props.range}
        options={RANGES}
        onChange={props.onRangeChange}
      />
    </div>
  );
}

export interface ProjectOption {
  readonly id: ProjectId;
  readonly label: string;
}

function CoverageNotes({ summary }: { summary: UsageSummary }) {
  const coverageDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(summary.coverage.coverageStartedAt));
  const reporting = summary.metrics.reporting;
  const legacyOnly =
    reporting != null && reporting.recordedTurnCount === 0 && reporting.legacyCostEventCount > 0;
  if (
    !summary.coverage.partialHistory &&
    summary.coverage.tokenUnreportedTurnCount === 0 &&
    summary.coverage.costUnreportedTurnCount === 0 &&
    !legacyOnly
  )
    return null;
  return (
    <section
      aria-label="Usage coverage"
      className="rounded-xl border border-warning/25 bg-warning/5 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-warning-foreground"
        />
        <div className="text-xs leading-relaxed">
          <p className="font-medium text-foreground">Coverage and provider reporting</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {summary.coverage.partialHistory ? (
              <li>
                Complete retained recording is available from {coverageDate}. Token and turn counts
                before then may be incomplete because recording started then or retention cleanup
                removed older data. Earlier provider-reported costs are included where available.
              </li>
            ) : null}
            {legacyOnly ? (
              <li>
                Only historical cost records exist in this range ({costLabel(summary.metrics)}).
                Complete historical turn counts are unavailable.
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
                {summary.coverage.providersMissingCost.map(providerLabel).join(", ")}; no price was
                estimated.
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </section>
  );
}

function coverageStatus(summary: UsageSummary): string {
  const reporting = summary.metrics.reporting;
  if (!reporting) return "Field coverage unavailable from this server.";
  if (reporting.recordedTurnCount === 0)
    return reporting.legacyCostEventCount > 0
      ? `${reporting.legacyCostEventCount} legacy cost records; no recorded turns.`
      : "No recorded turns in retained data.";
  const legacy =
    reporting.legacyCostEventCount > 0
      ? ` · ${reporting.legacyCostEventCount} legacy cost records`
      : "";
  return reporting.totalTokenTurnCount === reporting.recordedTurnCount
    ? `All ${reporting.recordedTurnCount} recorded turns reported token totals${legacy}.`
    : `Token totals reported for ${reporting.totalTokenTurnCount} of ${reporting.recordedTurnCount} recorded turns${legacy}.`;
}

/** The Activity body for one summary. */
export function UsageDashboardView(props: {
  readonly summary: UsageSummary;
  readonly range: UsageRange;
  readonly onRangeChange?: (range: UsageRange) => void;
  readonly showHeader?: boolean;
  readonly fetching: boolean;
  readonly accounts?: UsageAccounts | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly projectOptions?: ReadonlyArray<ProjectOption>;
  readonly projectName?: (projectId: ProjectId, title: string | null) => string;
  readonly onProjectChange?: (projectId: ProjectId | undefined) => void;
  readonly metric?: UsageMetric;
  readonly onMetricChange?: (metric: UsageMetric) => void;
  readonly onRefresh?: () => void;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onDismissError?: () => void;
  readonly renderAccounts?: boolean;
  readonly onSetPrice?: (provider: ProviderKind, model: string) => void;
}) {
  const { summary } = props;
  const [localMetric, setLocalMetric] = useState<UsageMetric>("tokens");
  const metric = props.metric ?? localMetric;
  const onMetricChange = props.onMetricChange ?? setLocalMetric;
  const turnsAvailable = summary.metrics.reporting != null;
  const chartMetric = metric === "turns" && !turnsAvailable ? "tokens" : metric;
  const total = tokenFieldDisplay(summary.metrics, "totalTokens");
  const input = tokenFieldDisplay(summary.metrics, "inputTokens");
  const output = tokenFieldDisplay(summary.metrics, "outputTokens");
  const cacheRead = tokenFieldDisplay(summary.metrics, "cacheReadTokens");
  const cacheWrite = tokenFieldDisplay(summary.metrics, "cacheWriteTokens");
  const records = recordCountDisplay(summary.metrics);
  const projectName =
    props.projectName ??
    ((_projectId: ProjectId, title: string | null) => title ?? "Unknown project");
  const noRecords =
    summary.metrics.reporting != null &&
    summary.metrics.reporting.recordedTurnCount === 0 &&
    summary.metrics.reporting.legacyCostEventCount === 0;

  return (
    <div className="flex w-full flex-col gap-5">
      {props.showHeader !== false && props.onRangeChange ? (
        <UsageHeader range={props.range} onRangeChange={props.onRangeChange} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">F5 activity</h2>
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
        <div className="flex flex-wrap items-center gap-2">
          {props.projectOptions && summary.projectScope ? (
            <select
              aria-label="History project"
              className="max-w-56 rounded-md border border-border bg-background p-1 text-xs"
              value={props.projectId ?? "all"}
              onChange={(event) =>
                props.onProjectChange?.(
                  event.target.value === "all" ? undefined : (event.target.value as ProjectId),
                )
              }
            >
              <option value="all">All projects</option>
              {props.projectOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}
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
          <span className="flex gap-1">
            {props.onRetry ? (
              <Button size="xs" variant="outline" onClick={props.onRetry}>
                Retry
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              aria-label="Dismiss refresh error"
              onClick={props.onDismissError}
            >
              Dismiss
            </Button>
          </span>
        </div>
      )}
      <div className="space-y-2">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total tokens"
            value={total.value}
            detail={
              total.detail ??
              (summary.metrics.reporting
                ? `${records.count} recorded turns`
                : `${summary.metrics.reportedTokenTurnCount} of ${summary.metrics.turnCount} usage records reported tokens`)
            }
            delta={tokenDelta(summary)}
            icon={SigmaIcon}
          />
          <MetricCard
            label="Input / output"
            value={`${input.value} / ${output.value}`}
            detail={
              input.detail || output.detail
                ? `Input ${input.detail ?? "complete"} · output ${output.detail ?? "complete"}`
                : "Provider-native fields; cache semantics can differ"
            }
            icon={GaugeIcon}
          />
          <MetricCard
            label="Cache read / write"
            value={`${cacheRead.value} / ${cacheWrite.value}`}
            detail={
              [
                cacheRateText(summary),
                cacheRead.detail || cacheWrite.detail
                  ? `Read ${cacheRead.detail ?? "complete"} · write ${cacheWrite.detail ?? "complete"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "Reported cache token fields only"
            }
            icon={RefreshCwIcon}
          />
          <MetricCard
            label="Cost"
            value={costLabel(summary.metrics)}
            detail={`${summary.metrics.pricedTurnCount} priced · ${summary.metrics.unpricedTurnCount} unpriced`}
            delta={costDelta(summary)}
            icon={CoinsIcon}
          />
        </div>
        <p role="status" className="text-2xs text-muted-foreground">
          {coverageStatus(summary)}
        </p>
      </div>
      <Card className="rounded-xl">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 p-4 pb-2">
          <CardTitle className="text-sm">Usage over time</CardTitle>
          <SegmentedControl
            label="Chart metric"
            value={chartMetric}
            options={METRICS.map((option) => ({
              ...option,
              disabled: option.value === "turns" && !turnsAvailable,
            }))}
            onChange={onMetricChange}
          />
        </CardHeader>
        <CardPanel className="p-4 pt-2">
          <StackedBarChart
            buckets={summary.buckets}
            metric={chartMetric}
            label={`${CHART_LABELS[chartMetric]} for ${rangeLabel(props.range)}`}
            timeZone={summary.timeZone}
            generatedAt={summary.generatedAt}
            hourly={summary.range === "24h"}
          />
        </CardPanel>
      </Card>
      {summary.projectScope ? (
        <ProjectsThreadsCard
          scope={summary.projectScope}
          metric={chartMetric}
          totalMetrics={summary.metrics}
          projectName={projectName}
          onSelectProject={(projectId) => props.onProjectChange?.(projectId)}
        />
      ) : null}
      <Card className="rounded-xl">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Providers and models</CardTitle>
        </CardHeader>
        <CardPanel className="overflow-x-auto p-0">
          {summary.byProvider.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {noRecords
                ? "No recorded turns in retained data."
                : "No completed turns in this range."}
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-y border-border/70 bg-muted/20 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Provider</th>
                  <th className="px-4 py-2 font-medium">Thread model</th>
                  <th className="px-4 py-2 text-right font-medium">{records.label}</th>
                  <th className="px-4 py-2 text-right font-medium">Tokens</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sortByMetric(summary.byProvider, chartMetric).map((entry) => {
                  const tokens = tokenFieldDisplay(entry.metrics, "totalTokens");
                  const entryRecords = recordCountDisplay(entry.metrics);
                  return (
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
                        {entryRecords.count}
                        {entryRecords.legacyCostEvents
                          ? ` + ${entryRecords.legacyCostEvents} legacy cost records`
                          : ""}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {tokens.value}
                        {tokens.detail ? (
                          <span className="block text-2xs text-muted-foreground">
                            {tokens.detail}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className="inline-flex items-center gap-2">
                          {costLabel(entry.metrics)}
                          {entry.model !== null &&
                          entry.metrics.unpricedTurnCount > 0 &&
                          props.onSetPrice ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              aria-label={`Set price for ${entry.model}`}
                              onClick={() => props.onSetPrice?.(entry.provider, entry.model!)}
                            >
                              Set price
                            </Button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardPanel>
      </Card>
      <CoverageNotes summary={summary} />
      <p className="text-xs text-muted-foreground">
        Claude history uses reported main-agent token fields. SDK-reported cost estimates can cover
        a broader scope and are not billing data.
      </p>
      {props.renderAccounts !== false && props.accounts && (
        <AccountUsageCards accounts={props.accounts} range={props.range} />
      )}
    </div>
  );
}

function useThrottled(callback: () => void, delayMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const state = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({
    last: 0,
    timer: null,
  });
  useEffect(
    () => () => {
      if (state.current.timer) clearTimeout(state.current.timer);
    },
    [],
  );
  return useMemo(
    () => () => {
      const current = state.current;
      if (current.timer) return;
      const wait = current.last + delayMs - Date.now();
      if (wait <= 0) {
        current.last = Date.now();
        callbackRef.current();
        return;
      }
      // Keep one trailing call so the final event is never dropped.
      current.timer = setTimeout(() => {
        current.timer = null;
        current.last = Date.now();
        callbackRef.current();
      }, wait);
    },
    [delayMs],
  );
}

function ActivityPanel(props: {
  readonly range: UsageRange;
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
  readonly projectId: ProjectId | undefined;
  readonly metric: UsageMetric;
  readonly timeZone: string;
  readonly onSearchChange: (patch: UsageSearchPatch) => void;
}) {
  const client = useQueryClient();
  const connection = useWsConnectionState();
  const connected = connection.phase === "connected";
  const options = usageSummaryQueryOptions({
    range: props.range,
    timeZone: props.timeZone,
    hiddenProviders: props.hiddenProviders,
    projectId: props.projectId,
    enabled: connected,
  });
  const summaryQuery = useQuery(options);
  const queryKey = options.queryKey;
  const queryHash = JSON.stringify(queryKey);
  const [dismissedErrorAt, setDismissedErrorAt] = useState(0);
  const [priceDraft, setPriceDraft] = useState<UsagePriceDraft | null>(null);
  const storeProjects = useStore((state) => state.projects);

  const refreshAll = useThrottled(() => {
    void refreshUsageSummaries(client);
  }, EVENT_THROTTLE_MS);

  // Usage facts and storage purges change totals while the page is open.
  useEffect(() => {
    const api = ensureNativeApi();
    const unsubscribers = [
      api.orchestration?.onDomainEvent?.((event) => {
        if (
          event.type === "thread.usage-recorded" ||
          (event.type === "thread.session-set" && event.payload.usageFact !== undefined)
        )
          refreshAll();
      }),
      api.storage?.onInvalidated?.(() => refreshAll()),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [refreshAll]);

  // Refresh on a later reconnect; the initial connection loads via `enabled`.
  const lastConnectedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || connection.connectedAt === null) return;
    const previous = lastConnectedAt.current;
    lastConnectedAt.current = connection.connectedAt;
    if (previous !== null && previous !== connection.connectedAt)
      void refreshUsageSummaries(client);
  }, [client, connected, connection.connectedAt]);

  // Roll over at the next natural bucket boundary instead of polling.
  const nextBucketAt = summaryQuery.data?.nextBucketAt ?? null;
  // Expired boundaries already refreshed once, so a failed refresh that keeps
  // the old summary cannot loop.
  const refreshedExpiredBoundary = useRef<string | null>(null);
  useEffect(() => {
    if (!nextBucketAt) return;
    const rollOver = () => {
      if (document.visibilityState === "hidden" || !onlineManager.isOnline()) {
        // Focus or reconnect fetches the stale key.
        void client.invalidateQueries({ queryKey, refetchType: "none" });
      } else {
        void refreshUsageSummaries(client, queryKey);
      }
    };
    const delay = Date.parse(nextBucketAt) - Date.now();
    if (!(delay > 0)) {
      // A cached summary can outlive its boundary (e.g. remounting just
      // after it passed); refresh it once.
      const boundary = `${queryHash}|${nextBucketAt}`;
      if (refreshedExpiredBoundary.current === boundary) return;
      refreshedExpiredBoundary.current = boundary;
      rollOver();
      return;
    }
    const timer = setTimeout(rollOver, delay + 50);
    return () => clearTimeout(timer);
    // queryHash stands in for the structurally equal key.
  }, [client, nextBucketAt, queryHash]);

  const scope = summaryQuery.data?.projectScope ?? null;
  const projectOptions = useMemo(() => {
    const options = new Map<string, { id: ProjectId; label: string }>();
    const storeNames = new Map(storeProjects.map((project) => [project.id, project.name]));
    for (const project of scope?.byProject ?? []) {
      if (project.projectId === null) continue;
      const name = project.title ?? storeNames.get(project.projectId) ?? project.projectId;
      options.set(project.projectId, {
        id: project.projectId,
        label: `${name}${project.deleted ? " (deleted)" : ""}`,
      });
    }
    for (const project of storeProjects)
      if (!options.has(project.id))
        options.set(project.id, { id: project.id, label: project.name });
    if (props.projectId && !options.has(props.projectId))
      options.set(props.projectId, { id: props.projectId, label: props.projectId });
    return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [scope, storeProjects, props.projectId]);
  const projectName = (projectId: ProjectId, title: string | null) =>
    title ?? storeProjects.find((project) => project.id === projectId)?.name ?? "Unknown project";

  const refresh = () => {
    setDismissedErrorAt(0);
    void refreshUsageSummaries(client, queryKey);
  };

  let body: ReactNode;
  const data = summaryQuery.data;
  if (summaryQuery.isPending) {
    body = (
      <div className="grid w-full gap-4" role="status" aria-label="Loading usage">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <AlertTriangleIcon aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
          <h2 className="mt-3 text-base font-medium">Usage is unavailable</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The server could not aggregate the requested usage range.
          </p>
          <Button className="mt-4" size="sm" variant="outline" onClick={refresh}>
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  } else if (props.projectId && data.projectScope == null) {
    body = (
      <div role="alert" className="rounded-lg border border-border p-4 text-sm">
        Project filtering is unsupported by this server, so project usage is not shown.{" "}
        <Button
          size="xs"
          variant="outline"
          onClick={() => props.onSearchChange({ projectId: undefined })}
        >
          Show all projects
        </Button>
      </div>
    );
  } else if (
    data.projectScope &&
    data.projectScope.selectedProjectId !== (props.projectId ?? null)
  ) {
    body = (
      <div role="alert" className="rounded-lg border border-border p-4 text-sm">
        The server returned usage for a different project than requested.{" "}
        <Button size="xs" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  } else {
    body = (
      <UsageDashboardView
        summary={data}
        range={props.range}
        showHeader={false}
        fetching={summaryQuery.isFetching}
        renderAccounts={false}
        projectId={props.projectId}
        projectOptions={projectOptions}
        projectName={projectName}
        onProjectChange={(projectId) => props.onSearchChange({ projectId })}
        metric={props.metric}
        onMetricChange={(metric) => props.onSearchChange({ metric })}
        onRefresh={refresh}
        onRetry={refresh}
        error={
          summaryQuery.isError && summaryQuery.errorUpdatedAt > dismissedErrorAt
            ? "Historical usage refresh failed."
            : null
        }
        onDismissError={() => setDismissedErrorAt(Date.now())}
        onSetPrice={(provider, model) =>
          setPriceDraft({ provider, model, nonce: Date.now() + Math.random() })
        }
      />
    );
  }
  return (
    <section aria-label="Activity" className="flex flex-col gap-5">
      {body}
      <UsagePriceEditor draft={priceDraft} />
    </section>
  );
}

/**
 * Account cards with their own loading and error state. The `activity`
 * variant keeps the Activity tab's plain account cards; refresh controls,
 * quota history, and forecasts belong to the Limits tab.
 */
function LimitsPanel(props: {
  readonly range: UsageRange;
  readonly variant: "activity" | "limits";
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
}) {
  const full = props.variant === "limits";
  const client = useQueryClient();
  const accountsQuery = useQuery(usageAccountsQueryOptions());
  const jobsPending = accountJobsPending(accountsQuery.data);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedErrorAt, setDismissedErrorAt] = useState(0);
  const force = useMutation({
    mutationKey: USAGE_ACCOUNTS_FORCE_MUTATION_KEY,
    mutationFn: () => forceRefreshUsageAccounts(client),
    onSuccess: (accounts) =>
      setNotice(
        accountJobsPending(accounts)
          ? "Refresh queued."
          : "No new refresh job started. A recent refresh cooldown or disabled accounts may apply.",
      ),
    onError: () => setNotice(null),
  });
  const forcePending =
    useMutationState({
      filters: { mutationKey: USAGE_ACCOUNTS_FORCE_MUTATION_KEY, status: "pending" },
    }).length > 0;
  const historyQuery = useQuery(usageQuotaHistoryQueryOptions(full && accountsQuery.isSuccess));
  const history = useMemo(
    () => (!full || historyQuery.isError ? undefined : indexQuotaHistory(historyQuery.data)),
    [full, historyQuery.data, historyQuery.isError],
  );
  // New samples exist once account jobs settle; history failures mean "no history".
  useEffect(() => {
    if (!full || !accountsQuery.dataUpdatedAt || jobsPending) return;
    void client.invalidateQueries(
      { queryKey: usageQueryKeys.quotaHistory },
      { cancelRefetch: false },
    );
  }, [client, full, accountsQuery.dataUpdatedAt, jobsPending]);

  const errorVisible =
    (force.isError && force.submittedAt > dismissedErrorAt) ||
    (accountsQuery.isError && accountsQuery.errorUpdatedAt > dismissedErrorAt);
  return (
    <section aria-label="Limits" className="space-y-3">
      {full ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={forcePending || jobsPending}
            onClick={() => {
              setNotice(null);
              force.mutate();
            }}
          >
            <RefreshCwIcon
              aria-hidden="true"
              className={cn("size-3.5", (forcePending || jobsPending) && "animate-spin")}
            />
            Refresh limits
          </Button>
          {notice ? (
            <span role="status" className="text-xs text-muted-foreground">
              {notice}
            </span>
          ) : null}
        </div>
      ) : null}
      {full ? (
        <p className="text-xs text-muted-foreground">
          The selected range affects only Codex UTC token history. Quota windows are independent of
          the range.
        </p>
      ) : null}
      {errorVisible ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs"
        >
          <span>
            Account snapshots could not be refreshed.
            {accountsQuery.data ? " Showing the last successful snapshots." : ""}
          </span>
          <span className="flex gap-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDismissedErrorAt(Date.now());
                // Join an in-flight (possibly forced) read instead of cancelling it.
                void accountsQuery.refetch({ cancelRefetch: false });
              }}
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label="Dismiss account error"
              onClick={() => setDismissedErrorAt(Date.now())}
            >
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}
      {accountsQuery.isPending ? (
        <div role="status" aria-label="Loading account usage">
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : null}
      {accountsQuery.data ? (
        <AccountUsageCards
          accounts={accountsQuery.data.filter(
            (account) => !props.hiddenProviders.includes(account.provider),
          )}
          range={props.range}
          history={history}
        />
      ) : null}
    </section>
  );
}

export function UsageDashboard(props: {
  /** Controlled URL state; when omitted the dashboard keeps local state. */
  search?: UsageSearchPatch;
  defaults?: { readonly tab?: UsageTab; readonly range?: UsageRange };
  onSearchChange?: (patch: UsageSearchPatch) => void;
  /** Saved provider filter; when omitted the dashboard keeps local state. */
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  onHiddenProvidersChange?: (hiddenProviders: ReadonlyArray<ProviderKind>) => void;
  /** Escape on the page; the route returns to the previous page. */
  onBack?: () => void;
}) {
  const [localSearch, setLocalSearch] = useState<UsageSearchPatch>({});
  const [localHidden, setLocalHidden] = useState<ReadonlyArray<ProviderKind>>([]);
  const hiddenProviders = props.hiddenProviders ?? localHidden;
  const hiddenProviderSet = useMemo(() => new Set(hiddenProviders), [hiddenProviders]);
  const onHiddenProvidersChange = props.onHiddenProvidersChange ?? setLocalHidden;
  const search = props.search ?? localSearch;
  const onSearchChange =
    props.onSearchChange ??
    ((patch: UsageSearchPatch) => setLocalSearch((current) => ({ ...current, ...patch })));
  const tab = search.tab ?? props.defaults?.tab ?? "activity";
  const range = search.range ?? props.defaults?.range ?? "7d";
  const timeZone = useMemo(resolveUsageTimeZone, []);
  const keybindings = useServerKeybindings();
  const handlersRef = useRef({ onSearchChange, onBack: props.onBack });
  handlersRef.current = { onSearchChange, onBack: props.onBack };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isUsageBackShortcut(event)) {
        if (!handlersRef.current.onBack) return;
        event.preventDefault();
        handlersRef.current.onBack();
        return;
      }
      const patch = resolveUsageShortcut(event, keybindings);
      if (!patch) return;
      event.preventDefault();
      handlersRef.current.onSearchChange(patch);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-7">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2" role="tablist" aria-label="Usage views">
          {(["activity", "limits"] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              variant={tab === value ? "default" : "outline"}
              onClick={() => onSearchChange({ tab: value })}
            >
              {value === "activity" ? "Activity" : "Limits"}
            </Button>
          ))}
        </div>
        <UsageProviderFilter
          hiddenProviders={hiddenProviderSet}
          onChange={onHiddenProvidersChange}
        />
      </div>
      <UsageHeader range={range} onRangeChange={(next) => onSearchChange({ range: next })} />
      {tab === "activity" ? (
        <>
          <ActivityPanel
            range={range}
            hiddenProviders={hiddenProviders}
            projectId={search.projectId}
            metric={search.metric ?? "tokens"}
            timeZone={timeZone}
            onSearchChange={onSearchChange}
          />
          <LimitsPanel range={range} variant="activity" hiddenProviders={hiddenProviders} />
        </>
      ) : (
        <LimitsPanel range={range} variant="limits" hiddenProviders={hiddenProviders} />
      )}
    </div>
  );
}
