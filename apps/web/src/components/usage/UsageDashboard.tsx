import {
  type ProjectId,
  type ProviderKind,
  type UsageAccount,
  type UsageAccounts,
  type UsageMetrics,
  type UsageRange,
  type UsageSummary,
} from "@t3tools/contracts";
import {
  onlineManager,
  focusManager,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  CircleAlertIcon,
  CoinsIcon,
  DownloadIcon,
  GaugeIcon,
  RefreshCwIcon,
  SigmaIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useSettings } from "../../hooks/useSettings";
import { useServerKeybindings } from "../../keybindings";
import { downloadTextFile } from "../../lib/downloadTextFile";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import {
  accountJobsPending,
  forceRefreshUsageAccounts,
  refreshUsageAccounts,
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UnderlineTabs } from "../ui/underline-tabs";
import {
  AccountUsageCard,
  AccountUsageCards,
  accountSectionId,
  indexQuotaHistory,
} from "./AccountUsageCards";
import { StackedBarChart } from "./charts/StackedBarChart";
import {
  cacheRateText,
  costDelta,
  costLabel,
  isCostUnknown,
  providerLabel,
  RANGES,
  rangeLabel,
  recordCountDisplay,
  resolveUsageTimeZone,
  tokenDelta,
  tokenFieldDisplay,
  totalCost,
  usageMetricValue,
} from "./format";
import {
  AboutTheseNumbers,
  StatTile,
  type UsageColumn,
  type UsageSort,
  UsageSection,
  UsageTable,
  UsageToggle,
} from "./kit";
import { LimitsGlance } from "./LimitsGlance";
import { ProjectsThreadsCard } from "./ProjectsThreadsCard";
import { BudgetAlerts, BudgetSection, useMonthToDateUsage } from "./UsageBudget";
import { USAGE_CSV_KINDS, usageCsv, usageCsvFilename } from "./usageCsv";
import { UsagePriceDialog, type UsagePriceDraft } from "./UsagePriceDialog";
import { unpricedModelCount, UsagePricingPanel } from "./UsagePricingPanel";
import { UsageProviderFilter } from "./UsageProviderFilter";
import { isUsageBackShortcut, resolveUsageShortcut } from "./usageShortcuts";

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

const TAB_ORDER: ReadonlyArray<{ readonly value: UsageTab; readonly label: string }> = [
  { value: "limits", label: "Limits" },
  { value: "activity", label: "Activity" },
  { value: "pricing", label: "Pricing" },
];

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

const HEADER_NOTE =
  "Historical provider-reported tokens and API-equivalent cost, plus account usage and limits. Subscription or invoice spend may differ.";
const CLAUDE_HISTORY_NOTE =
  "Claude history uses reported main-agent token fields. SDK-reported cost estimates can cover a broader scope and are not billing data.";
const LIMITS_RANGE_NOTE =
  "The selected range affects only Codex UTC token history. Quota windows are independent of the range.";

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
    !summary.metrics.unpricedNativeInferenceCount &&
    !legacyOnly
  )
    return null;
  return (
    <section aria-label="Usage coverage">
      <Alert variant="warning" role="note">
        <AlertTriangleIcon aria-hidden="true" />
        <AlertTitle className="text-xs">Coverage and provider reporting</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          <ul className="list-disc space-y-0.5 pl-4">
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
        </AlertDescription>
      </Alert>
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

/** "Updated 2m ago" with the absolute time on hover. */
function Freshness(props: { readonly at: string | null; readonly prefix?: string }) {
  if (!props.at) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default text-xs text-muted-foreground" />}>
        {props.prefix ?? "Updated"} {formatRelativeTimeLabel(props.at)}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{formatAbsoluteTimeLabel(props.at)}</TooltipPopup>
    </Tooltip>
  );
}

function ProjectSelect(props: {
  readonly projectId: ProjectId | undefined;
  readonly options: ReadonlyArray<ProjectOption>;
  readonly onChange: (projectId: ProjectId | undefined) => void;
}) {
  const selected = props.options.find((option) => option.id === props.projectId);
  return (
    <Select
      value={props.projectId ?? "all"}
      onValueChange={(value) =>
        props.onChange(!value || value === "all" ? undefined : (value as ProjectId))
      }
    >
      <SelectTrigger size="xs" className="w-auto max-w-56 min-w-32" aria-label="History project">
        <SelectValue>{selected?.label ?? "All projects"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="all">All projects</SelectItem>
        {props.options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ProvidersModelsSection(props: {
  readonly summary: UsageSummary;
  readonly metric: UsageMetric;
  readonly noRecords: boolean;
  readonly onSetPrice?: ((provider: ProviderKind, model: string) => void) | undefined;
}) {
  const [sort, setSort] = useState<UsageSort | null>(null);
  const records = recordCountDisplay(props.summary.metrics);
  type Entry = UsageSummary["byProvider"][number];
  const metricColumn =
    props.metric === "cost" ? "cost" : props.metric === "turns" ? "turns" : "tokens";
  const columns: Array<UsageColumn<Entry>> = [
    {
      key: "provider",
      header: "Provider",
      sortValue: (entry) => providerLabel(entry.provider),
      className: "font-medium text-foreground",
      render: (entry) => providerLabel(entry.provider),
    },
    {
      key: "model",
      header: "Thread model",
      sortValue: (entry) => entry.model ?? "",
      className: "max-w-72 truncate font-mono text-muted-foreground",
      render: (entry) => entry.model ?? "Unavailable for historical cost",
    },
    {
      key: "turns",
      header: records.label,
      align: "right",
      sortValue: (entry) => entry.metrics.turnCount,
      render: (entry) => {
        const entryRecords = recordCountDisplay(entry.metrics);
        return `${entryRecords.count}${
          entryRecords.legacyCostEvents
            ? ` + ${entryRecords.legacyCostEvents} legacy cost records`
            : ""
        }`;
      },
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortValue: (entry) => entry.metrics.totalTokens,
      render: (entry) => {
        const tokens = tokenFieldDisplay(entry.metrics, "totalTokens");
        return (
          <>
            {tokens.value}
            {tokens.detail ? (
              <span className="block text-2xs text-muted-foreground">{tokens.detail}</span>
            ) : null}
          </>
        );
      },
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (entry) => (isCostUnknown(entry.metrics) ? -1 : totalCost(entry.metrics)),
      render: (entry) => (
        <span className="inline-flex items-center gap-2">
          {costLabel(entry.metrics)}
          {entry.model !== null &&
          (entry.metrics.unpricedTurnCount > 0 ||
            (entry.metrics.unpricedNativeInferenceCount ?? 0) > 0) &&
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
      ),
    },
  ];
  return (
    <UsageSection title="Providers and models" flush>
      <UsageTable
        caption="Providers and models"
        columns={columns}
        rows={sortByMetric(props.summary.byProvider, props.metric)}
        rowKey={(entry) => `${entry.provider}:${entry.model ?? "legacy"}`}
        sort={sort ?? { key: metricColumn, direction: "desc" }}
        onSortChange={setSort}
        empty={
          props.noRecords
            ? "No recorded turns in retained data."
            : "No completed turns in this range."
        }
      />
    </UsageSection>
  );
}

/** The Activity body for one summary. */
export function UsageDashboardView(props: {
  readonly summary: UsageSummary;
  readonly range: UsageRange;
  readonly onRangeChange?: (range: UsageRange) => void;
  /** A compact range/refresh row for standalone use; the page header replaces it. */
  readonly showHeader?: boolean;
  readonly fetching: boolean;
  /** Full account cards for standalone use; the page shows them on the Limits tab. */
  readonly accounts?: UsageAccounts | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly projectOptions?: ReadonlyArray<ProjectOption>;
  readonly projectName?: (projectId: ProjectId, title: string | null) => string;
  readonly onProjectChange?: (projectId: ProjectId | undefined) => void;
  readonly metric?: UsageMetric;
  readonly onMetricChange?: (metric: UsageMetric) => void;
  readonly compare?: boolean;
  readonly onCompareChange?: (compare: boolean) => void;
  readonly onRefresh?: () => void;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly onDismissError?: () => void;
  readonly onSetPrice?: (provider: ProviderKind, model: string) => void;
  readonly onReviewPrices?: () => void;
  /** Rendered first, before notices (Limits at a glance). */
  readonly leading?: ReactNode;
  /** Extra notices after the refresh error (budget). */
  readonly notices?: ReactNode;
  /** Rendered after the stat tiles (monthly budget). */
  readonly budget?: ReactNode;
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
    summary.metrics.reporting.legacyCostEventCount === 0 &&
    !summary.metrics.nativeInferenceCount;
  const unpriced = unpricedModelCount(summary);
  const status = coverageStatus(summary);

  return (
    <div className="flex w-full flex-col gap-4">
      {props.showHeader !== false && (props.onRangeChange || props.onRefresh) ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Freshness at={summary.generatedAt} />
          {props.onRefresh ? (
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Refresh usage"
              disabled={props.fetching}
              onClick={props.onRefresh}
            >
              <RefreshCwIcon aria-hidden="true" className={cn(props.fetching && "animate-spin")} />
            </Button>
          ) : null}
          {props.projectOptions && summary.projectScope && props.onProjectChange ? (
            <ProjectSelect
              projectId={props.projectId}
              options={props.projectOptions}
              onChange={props.onProjectChange}
            />
          ) : null}
          {props.onRangeChange ? (
            <UsageToggle
              label="Usage range"
              value={props.range}
              options={RANGES}
              onChange={props.onRangeChange}
            />
          ) : null}
        </div>
      ) : null}
      {props.leading}
      {props.error && (
        <Alert variant="error">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-foreground">
            {props.error} Last successful history update:{" "}
            {formatAbsoluteTimeLabel(summary.generatedAt)}.
          </AlertDescription>
          <AlertAction>
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
          </AlertAction>
        </Alert>
      )}
      {unpriced > 0 && props.onReviewPrices ? (
        <Alert variant="warning" role="note" aria-label="Unpriced models">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-foreground">
            {unpriced === 1
              ? "1 model has unpriced usage, so cost is understated."
              : `${unpriced} models have unpriced usage, so cost is understated.`}
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={props.onReviewPrices}>
              Review prices
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {props.notices}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total tokens"
          value={total.value}
          detail={
            total.detail ??
            (summary.metrics.reporting
              ? `${records.count} recorded turns${summary.metrics.nativeInferenceCount ? " · " + summary.metrics.nativeInferenceCount + " native model calls" : ""}`
              : `${summary.metrics.reportedTokenTurnCount} of ${summary.metrics.turnCount} usage records reported tokens`)
          }
          delta={tokenDelta(summary)}
          icon={SigmaIcon}
        />
        <StatTile
          label="Input / output"
          value={`${input.value} / ${output.value}`}
          detail={
            input.detail || output.detail
              ? `Input ${input.detail ?? "complete"} · output ${output.detail ?? "complete"}`
              : "Provider-native fields; cache semantics can differ"
          }
          icon={GaugeIcon}
        />
        <StatTile
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
        <StatTile
          label="Cost"
          value={costLabel(summary.metrics)}
          detail={
            summary.metrics.nativeInferenceCount
              ? `${summary.metrics.pricedTurnCount} priced turns · ${summary.metrics.unpricedTurnCount} unpriced turns · ${summary.metrics.unpricedNativeInferenceCount ?? 0} unpriced model calls`
              : `${summary.metrics.pricedTurnCount} priced · ${summary.metrics.unpricedTurnCount} unpriced`
          }
          delta={costDelta(summary)}
          icon={CoinsIcon}
        />
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
      {props.budget}
      <UsageSection
        title="Usage over time"
        actions={
          <>
            {props.onCompareChange ? (
              <Toggle
                size="xs"
                variant="outline"
                className="px-2 text-xs"
                aria-label="Compare to previous period"
                pressed={props.compare ?? false}
                onPressedChange={(pressed) => props.onCompareChange?.(pressed)}
              >
                <ArrowLeftRightIcon aria-hidden="true" />
                Compare
              </Toggle>
            ) : null}
            <UsageToggle
              label="Chart metric"
              value={chartMetric}
              options={METRICS.map((option) => ({
                ...option,
                disabled: option.value === "turns" && !turnsAvailable,
              }))}
              onChange={onMetricChange}
            />
          </>
        }
      >
        <StackedBarChart
          buckets={summary.buckets}
          metric={chartMetric}
          label={`${CHART_LABELS[chartMetric]} for ${rangeLabel(props.range)}`}
          timeZone={summary.timeZone}
          generatedAt={summary.generatedAt}
          hourly={summary.range === "24h"}
          previous={props.compare ? (summary.previousBuckets ?? null) : null}
        />
        {props.compare && !summary.previousBuckets ? (
          <p className="mt-2 text-2xs text-muted-foreground">
            The previous period predates complete recording, so it can't be compared.
          </p>
        ) : null}
      </UsageSection>
      <ProvidersModelsSection
        summary={summary}
        metric={chartMetric}
        noRecords={noRecords}
        onSetPrice={props.onSetPrice}
      />
      {summary.projectScope ? (
        <ProjectsThreadsCard
          scope={summary.projectScope}
          metric={chartMetric}
          totalMetrics={summary.metrics}
          projectName={projectName}
          onSelectProject={(projectId) => props.onProjectChange?.(projectId)}
        />
      ) : null}
      <CoverageNotes summary={summary} />
      {summary.nativeHistoryStatus === "refreshing" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Refreshing Muse Code history…
        </p>
      ) : null}
      {summary.nativeHistoryStatus === "error" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {summary.nativeHistoryError ?? "Muse Code history could not refresh."} Previously loaded
          history is retained. Failed refreshes retry with increasing backoff, up to ten minutes.
        </p>
      ) : null}
      {summary.metrics.nativeInferenceCount ? (
        <p className="text-xs text-muted-foreground">
          {summary.metrics.nativeInferenceCount} native Muse model calls included. Model calls are
          separate from recorded turns.
        </p>
      ) : null}
      {props.accounts ? <AccountUsageCards accounts={props.accounts} range={props.range} /> : null}
      <AboutTheseNumbers notes={[HEADER_NOTE, status, CLAUDE_HISTORY_NOTE]} />
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

/**
 * The page's history summary, shared by the header, Activity and Pricing: live
 * refresh on usage events, reconnects and bucket rollover.
 */
function useUsageSummary(input: {
  readonly range: UsageRange;
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
  readonly projectId: ProjectId | undefined;
  readonly compare: boolean;
  readonly timeZone: string;
}) {
  const client = useQueryClient();
  const connection = useWsConnectionState();
  const connected = connection.phase === "connected";
  const options = usageSummaryQueryOptions({
    range: input.range,
    timeZone: input.timeZone,
    hiddenProviders: input.hiddenProviders,
    projectId: input.projectId,
    comparePrevious: input.compare,
    enabled: connected,
  });
  // Toggling Compare changes the key; show the other variant's data meanwhile
  // instead of swapping the whole tab for a skeleton.
  const siblingKey = usageQueryKeys.summary(
    input.range,
    input.timeZone,
    undefined,
    input.projectId,
    input.hiddenProviders,
    !input.compare,
  );
  const query = useQuery({
    ...options,
    placeholderData: () => {
      const sibling = client.getQueryData<UsageSummary>(siblingKey);
      return sibling && !input.compare ? { ...sibling, previousBuckets: null } : sibling;
    },
  });
  const queryKey = options.queryKey;
  const queryHash = JSON.stringify(queryKey);
  const [dismissedErrorAt, setDismissedErrorAt] = useState(0);
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
  const nextBucketAt = query.data?.nextBucketAt ?? null;
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

  const scope = query.data?.projectScope ?? null;
  const projectOptions = useMemo(() => {
    const options = new Map<string, ProjectOption>();
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
    if (input.projectId && !options.has(input.projectId))
      options.set(input.projectId, { id: input.projectId, label: input.projectId });
    return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [scope, storeProjects, input.projectId]);
  const projectName = (projectId: ProjectId, title: string | null) =>
    title ?? storeProjects.find((project) => project.id === projectId)?.name ?? "Unknown project";

  const refresh = () => {
    setDismissedErrorAt(0);
    void refreshUsageSummaries(client, queryKey);
  };
  const error =
    query.isError && query.errorUpdatedAt > dismissedErrorAt
      ? "Historical usage refresh failed."
      : null;
  return {
    query,
    refresh,
    error,
    dismissError: () => setDismissedErrorAt(Date.now()),
    projectOptions,
    projectName,
  };
}

type SummaryState = ReturnType<typeof useUsageSummary>;

/** The Limits tab's forced refresh; the header button drives it. */
function useLimitsRefresh() {
  const client = useQueryClient();
  const [snapshotsReady, setSnapshotsReady] = useState(
    () => client.getQueryData(usageQueryKeys.accounts) !== undefined,
  );
  const accountsQuery = useQuery({
    ...usageAccountsQueryOptions(),
    enabled: snapshotsReady,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = () => refreshUsageAccounts(client).then(() => setSnapshotsReady(true));
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden" || !onlineManager.isOnline()) return;
      const accounts = client.getQueryData<UsageAccounts>(usageQueryKeys.accounts);
      if (!accountJobsPending(accounts))
        void refreshUsageAccounts(client)
          .then(() => setSnapshotsReady(true))
          .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 300_000);
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) refresh();
    });
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) refresh();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribeFocus();
      unsubscribe();
    };
  }, [client]);
  const jobsPending = accountJobsPending(accountsQuery.data);
  const [notice, setNotice] = useState<string | null>(null);
  const force = useMutation({
    mutationKey: USAGE_ACCOUNTS_FORCE_MUTATION_KEY,
    mutationFn: () => forceRefreshUsageAccounts(client),
    onSuccess: (accounts) => {
      setSnapshotsReady(true);
      setNotice(
        accountJobsPending(accounts)
          ? "Refresh queued."
          : "No new refresh job started. A recent refresh cooldown or disabled accounts may apply.",
      );
    },
    onError: () => setNotice(null),
  });
  const forcePending =
    useMutationState({
      filters: { mutationKey: USAGE_ACCOUNTS_FORCE_MUTATION_KEY, status: "pending" },
    }).length > 0;
  return {
    accountsQuery,
    retry,
    jobsPending,
    force,
    busy: forcePending || jobsPending,
    notice,
    start: () => {
      setNotice(null);
      force.mutate();
    },
  };
}

type LimitsRefresh = ReturnType<typeof useLimitsRefresh>;

function ActivitySkeleton() {
  return (
    <div className="grid w-full gap-4" role="status" aria-label="Loading usage">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function ActivityPanel(props: {
  readonly range: UsageRange;
  readonly projectId: ProjectId | undefined;
  readonly metric: UsageMetric;
  readonly compare: boolean;
  readonly timeZone: string;
  readonly summary: SummaryState;
  readonly limits: LimitsRefresh;
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
  readonly onSearchChange: (patch: UsageSearchPatch) => void;
  readonly onOpenAccount: (account: UsageAccount) => void;
  readonly onSetPrice: (provider: ProviderKind, model: string) => void;
}) {
  const { summary } = props;
  const budget = useSettings((settings) => settings.usageMonthlyBudget) ?? null;
  const monthToDate = useMonthToDateUsage({ budget, timeZone: props.timeZone, enabled: true });
  const openPricing = () => props.onSearchChange({ tab: "pricing" });
  const accounts = props.limits.accountsQuery.data?.filter(
    (account) => !props.hiddenProviders.includes(account.provider),
  );
  const glance = (
    <LimitsGlance
      accounts={accounts}
      loading={props.limits.accountsQuery.isPending}
      onOpenAccount={props.onOpenAccount}
      onViewDetails={() => props.onSearchChange({ tab: "limits" })}
    />
  );

  let body: ReactNode;
  const data = summary.query.data;
  if (summary.query.isPending) {
    body = (
      <>
        {glance}
        <ActivitySkeleton />
      </>
    );
  } else if (!data) {
    body = (
      <>
        {glance}
        <UsageSection title="Usage is unavailable" aria-label="Usage unavailable">
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              The server could not aggregate the requested usage range.
            </p>
            <Button size="sm" variant="outline" onClick={summary.refresh}>
              <RefreshCwIcon aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </div>
        </UsageSection>
      </>
    );
  } else if (props.projectId && data.projectScope == null) {
    body = (
      <>
        {glance}
        <Alert variant="warning">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-foreground">
            Project filtering is unsupported by this server, so project usage is not shown.
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => props.onSearchChange({ projectId: undefined })}
            >
              Show all projects
            </Button>
          </AlertAction>
        </Alert>
      </>
    );
  } else if (
    data.projectScope &&
    data.projectScope.selectedProjectId !== (props.projectId ?? null)
  ) {
    body = (
      <>
        {glance}
        <Alert variant="error">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-foreground">
            The server returned usage for a different project than requested.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={summary.refresh}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </>
    );
  } else {
    body = (
      <UsageDashboardView
        summary={data}
        range={props.range}
        showHeader={false}
        fetching={summary.query.isFetching}
        projectId={props.projectId}
        projectOptions={summary.projectOptions}
        projectName={summary.projectName}
        onProjectChange={(projectId) => props.onSearchChange({ projectId })}
        metric={props.metric}
        onMetricChange={(metric) => props.onSearchChange({ metric })}
        compare={props.compare}
        onCompareChange={(compare) => props.onSearchChange({ compare: compare || undefined })}
        onRefresh={summary.refresh}
        onRetry={summary.refresh}
        error={summary.error}
        onDismissError={summary.dismissError}
        onSetPrice={props.onSetPrice}
        onReviewPrices={openPricing}
        leading={glance}
        notices={<BudgetAlerts budget={budget} usage={monthToDate} onEdit={openPricing} />}
        budget={<BudgetSection budget={budget} usage={monthToDate} onEdit={openPricing} />}
      />
    );
  }
  return (
    <section aria-label="Activity" className="flex flex-col gap-4">
      {body}
    </section>
  );
}

/** Account overview tiles, then each account's full section with history and forecasts. */
function LimitsPanel(props: {
  readonly range: UsageRange;
  readonly hiddenProviders: ReadonlyArray<ProviderKind>;
  readonly limits: LimitsRefresh;
  readonly scrollTarget: string | null;
  readonly onScrolled: () => void;
  readonly onOpenAccount: (account: UsageAccount) => void;
}) {
  const client = useQueryClient();
  const { accountsQuery, force, jobsPending } = props.limits;
  const [dismissedErrorAt, setDismissedErrorAt] = useState(0);
  const historyQuery = useQuery(usageQuotaHistoryQueryOptions(accountsQuery.isSuccess));
  const history = useMemo(
    () => (historyQuery.isError ? undefined : indexQuotaHistory(historyQuery.data)),
    [historyQuery.data, historyQuery.isError],
  );
  // New samples exist once account jobs settle; history failures mean "no history".
  useEffect(() => {
    if (!accountsQuery.dataUpdatedAt || jobsPending) return;
    void client.invalidateQueries(
      { queryKey: usageQueryKeys.quotaHistory },
      { cancelRefetch: false },
    );
  }, [client, accountsQuery.dataUpdatedAt, jobsPending]);
  const accounts = accountsQuery.data?.filter(
    (account) => !props.hiddenProviders.includes(account.provider),
  );
  // Scroll to an account opened from a glance tile once its section exists.
  const { scrollTarget, onScrolled } = props;
  useEffect(() => {
    if (!scrollTarget || !accounts) return;
    const element = document.getElementById(scrollTarget);
    if (!element) return;
    element.scrollIntoView?.({ block: "start", behavior: "smooth" });
    onScrolled();
  }, [scrollTarget, accounts, onScrolled]);

  const errorVisible =
    (force.isError && force.submittedAt > dismissedErrorAt) ||
    (accountsQuery.isError && accountsQuery.errorUpdatedAt > dismissedErrorAt);
  return (
    <section aria-label="Limits" className="flex flex-col gap-4">
      {errorVisible ? (
        <Alert variant="error">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-xs text-foreground">
            Account snapshots could not be refreshed.
            {accountsQuery.data ? " Showing the last successful snapshots." : ""}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDismissedErrorAt(Date.now());
                // Join an in-flight (possibly forced) read instead of cancelling it.
                void props.limits.retry().catch(() => {});
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
          </AlertAction>
        </Alert>
      ) : null}
      {accountsQuery.isPending ? (
        <div role="status" aria-label="Loading account usage" className="flex flex-col gap-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : null}
      {accounts && accounts.length > 1 ? (
        <LimitsGlance
          title="Overview"
          accounts={accounts}
          loading={false}
          onOpenAccount={props.onOpenAccount}
        />
      ) : null}
      {accounts ? (
        <section aria-label="Account usage and limits" className="flex flex-col gap-4">
          {accounts.map((account) => (
            <AccountUsageCard
              key={account.key}
              account={account}
              range={props.range}
              history={history}
            />
          ))}
        </section>
      ) : null}
      <AboutTheseNumbers
        notes={[
          LIMITS_RANGE_NOTE,
          "Quota meters show provider-reported usage. The tick on each bar marks how much of the window has elapsed.",
        ]}
      />
    </section>
  );
}

function ExportMenu(props: {
  readonly summary: UsageSummary;
  readonly range: UsageRange;
  readonly projectName: (projectId: ProjectId, title: string | null) => string;
}) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" aria-label="Export usage" />}>
        <DownloadIcon aria-hidden="true" />
        Export
      </MenuTrigger>
      <MenuPopup align="end">
        {USAGE_CSV_KINDS.filter(
          (entry) =>
            props.summary.projectScope || (entry.kind !== "projects" && entry.kind !== "threads"),
        ).map((entry) => (
          <MenuItem
            key={entry.kind}
            onClick={() =>
              downloadTextFile(
                usageCsvFilename(props.range, entry.kind),
                usageCsv(props.summary, entry.kind, props.projectName),
                "text/csv;charset=utf-8",
              )
            }
          >
            {entry.label} (CSV)
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
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
  const metric = search.metric ?? "tokens";
  const compare = search.compare === true;
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

  const summary = useUsageSummary({
    range,
    hiddenProviders,
    projectId: search.projectId,
    compare: tab === "activity" && compare,
    timeZone,
  });
  const limits = useLimitsRefresh();
  const [priceDraft, setPriceDraft] = useState<UsagePriceDraft | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const onScrolled = useMemo(() => () => setScrollTarget(null), []);
  const setPrice = (provider: ProviderKind, model: string) =>
    setPriceDraft({ provider, model, nonce: Date.now() + Math.random() });
  const openAccount = (account: UsageAccount) => {
    setScrollTarget(accountSectionId(account));
    if (tab !== "limits") onSearchChange({ tab: "limits" });
  };
  const data = summary.query.data;
  const unpriced = unpricedModelCount(data);
  const limitsUpdatedAt = limits.accountsQuery.dataUpdatedAt
    ? new Date(limits.accountsQuery.dataUpdatedAt).toISOString()
    : null;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 sm:py-7">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
            <Freshness at={tab === "limits" ? limitsUpdatedAt : (data?.generatedAt ?? null)} />
            {tab === "limits" ? (
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Refresh limits"
                disabled={limits.busy}
                onClick={limits.start}
              >
                <RefreshCwIcon aria-hidden="true" className={cn(limits.busy && "animate-spin")} />
              </Button>
            ) : (
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Refresh usage"
                disabled={summary.query.isFetching}
                onClick={summary.refresh}
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={cn(summary.query.isFetching && "animate-spin")}
                />
              </Button>
            )}
            {tab === "limits" && limits.notice ? (
              <span role="status" className="text-xs text-muted-foreground">
                {limits.notice}
              </span>
            ) : null}
          </div>
          {tab === "activity" && data ? (
            <ExportMenu summary={data} range={range} projectName={summary.projectName} />
          ) : null}
        </div>
        <UnderlineTabs
          aria-label="Usage views"
          value={tab}
          onValueChange={(value) => onSearchChange({ tab: value })}
          tabs={TAB_ORDER.map((entry) => ({
            value: entry.value,
            label: entry.label,
            adornment:
              entry.value === "pricing" && unpriced > 0 ? (
                <Badge size="sm" variant="warning" aria-label={`${unpriced} unpriced models`}>
                  {unpriced}
                </Badge>
              ) : undefined,
          }))}
          trailing={
            <>
              <UsageToggle
                label="Usage range"
                value={range}
                options={RANGES}
                onChange={(next) => onSearchChange({ range: next })}
              />
              <UsageProviderFilter
                hiddenProviders={hiddenProviderSet}
                onChange={onHiddenProvidersChange}
              />
              {tab !== "limits" && data?.projectScope ? (
                <ProjectSelect
                  projectId={search.projectId}
                  options={summary.projectOptions}
                  onChange={(projectId) => onSearchChange({ projectId })}
                />
              ) : null}
            </>
          }
        />
      </header>
      {tab === "activity" ? (
        <ActivityPanel
          range={range}
          projectId={search.projectId}
          metric={metric}
          compare={compare}
          timeZone={timeZone}
          summary={summary}
          limits={limits}
          hiddenProviders={hiddenProviders}
          onSearchChange={onSearchChange}
          onOpenAccount={openAccount}
          onSetPrice={setPrice}
        />
      ) : tab === "limits" ? (
        <LimitsPanel
          range={range}
          hiddenProviders={hiddenProviders}
          limits={limits}
          scrollTarget={scrollTarget}
          onScrolled={onScrolled}
          onOpenAccount={openAccount}
        />
      ) : (
        <UsagePricingPanel summary={data} loading={summary.query.isPending} onSetPrice={setPrice} />
      )}
      <UsagePriceDialog draft={priceDraft} onClose={() => setPriceDraft(null)} />
    </div>
  );
}
