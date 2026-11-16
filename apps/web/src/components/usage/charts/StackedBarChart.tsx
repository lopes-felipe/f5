import type { UsageBucket, UsageMetrics, UsagePreviousBucket } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Tooltip, TooltipPopup } from "../../ui/tooltip";
import {
  bucketEndAt,
  compactNumber,
  formatBucketInterval,
  formatUsd,
  recordCountDisplay,
  tokenFieldDisplay,
} from "../format";
import { usageTableClasses } from "../kit";
import { ChartLegend, COST_SEGMENTS, TOKEN_SEGMENTS } from "./ChartLegend";

export type UsageChartMetric = "tokens" | "cost" | "turns";

interface Segment {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly value: number;
}

interface Column {
  readonly bucket: UsageBucket;
  readonly segments: ReadonlyArray<Segment>;
  readonly total: number;
  readonly interval: string;
  /** The aligned previous-period value, when comparing. */
  readonly previous: number | null;
}

function previousValue(metrics: UsageMetrics, metric: UsageChartMetric): number {
  if (metric === "cost")
    return (metrics.providerReportedCostUsd ?? 0) + (metrics.estimatedCostUsd ?? 0);
  if (metric === "turns") return metrics.reporting?.recordedTurnCount ?? metrics.turnCount;
  return metrics.totalTokens;
}

function tokenSegments(bucket: UsageBucket): ReadonlyArray<Segment> {
  const segments = TOKEN_SEGMENTS.map((segment) => ({
    ...segment,
    value: bucket.composition?.[segment.key] ?? 0,
  }));
  return segments.some((segment) => segment.value > 0)
    ? segments
    : // Older responses without composition fall back to the known total.
      [{ key: "total", label: "Total", color: "bg-primary/70", value: bucket.metrics.totalTokens }];
}

function segmentsFor(bucket: UsageBucket, metric: UsageChartMetric): ReadonlyArray<Segment> {
  if (metric === "cost")
    return [
      { ...COST_SEGMENTS[0], value: bucket.metrics.providerReportedCostUsd ?? 0 },
      { ...COST_SEGMENTS[1], value: bucket.metrics.estimatedCostUsd ?? 0 },
    ];
  if (metric === "turns")
    return [
      {
        key: "turns",
        label: "Recorded turns",
        color: "bg-primary",
        value: bucket.metrics.reporting?.recordedTurnCount ?? 0,
      },
    ];
  return tokenSegments(bucket);
}

/** Rounds up to 1/2/2.5/5 x 10^k steps so three ticks read cleanly. */
function niceStep(max: number, integer: boolean): number {
  if (max <= 0) return 0;
  const raw = max / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ??
    10 * magnitude;
  return integer ? Math.max(1, Math.ceil(step)) : step;
}

function formatValue(value: number, metric: UsageChartMetric): string {
  if (metric === "cost") return formatUsd(value, 2);
  return metric === "turns" ? Math.round(value).toLocaleString() : compactNumber(value);
}

function bucketDetails(bucket: UsageBucket): Array<string> {
  const metrics = bucket.metrics;
  const tokens = tokenFieldDisplay(metrics, "totalTokens");
  const records = recordCountDisplay(metrics);
  const lines = [
    `Tokens: ${tokens.value}${tokens.detail ? ` (${tokens.detail})` : ""}`,
    `Reported cost: ${
      metrics.providerReportedCostUsd === null ? "none" : formatUsd(metrics.providerReportedCostUsd)
    }`,
  ];
  if (metrics.estimatedCostUsd !== undefined && metrics.estimatedCostUsd !== null)
    lines.push(`Estimated cost: ${formatUsd(metrics.estimatedCostUsd)}`);
  if (metrics.unpricedTurnCount > 0) lines.push(`Unpriced: ${metrics.unpricedTurnCount}`);
  lines.push(`${records.label}: ${records.count}`);
  if (records.legacyCostEvents) lines.push(`Legacy cost records: ${records.legacyCostEvents}`);
  return lines;
}

export function StackedBarChart({
  buckets,
  label,
  timeZone,
  metric = "tokens",
  generatedAt,
  hourly,
  previous,
}: {
  buckets: ReadonlyArray<UsageBucket>;
  /** Previous-period buckets, index-aligned with `buckets`; draws a tick per column. */
  previous?: ReadonlyArray<UsagePreviousBucket> | null;
  label: string;
  timeZone: string;
  metric?: UsageChartMetric;
  generatedAt: string;
  hourly: boolean;
}) {
  const columns: Array<Column> = buckets.map((bucket, index) => {
    const segments = segmentsFor(bucket, metric);
    return {
      bucket,
      segments,
      total: segments.reduce((sum, segment) => sum + segment.value, 0),
      interval: `${formatBucketInterval({
        startAt: bucket.startAt,
        endAt: bucketEndAt(buckets, index, generatedAt),
        timeZone,
        hourly,
      })} (${timeZone})`,
      previous: previous?.[index] ? previousValue(previous[index].metrics, metric) : null,
    };
  });
  const previousLabel = (column: Column) =>
    column.previous === null ? null : `Previous period: ${formatValue(column.previous, metric)}`;
  const lastIndex = Math.max(0, columns.length - 1);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const columnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const plotRef = useRef<HTMLDivElement | null>(null);
  // Selection survives refreshes by key and clamps to the last bucket.
  const indexOf = (key: string | null) => {
    if (key === null) return lastIndex;
    const index = columns.findIndex((column) => column.bucket.key === key);
    return index === -1 ? lastIndex : index;
  };
  const activeIndex = indexOf(activeKey);
  const pinnedIndex = pinnedKey === null ? null : indexOf(pinnedKey);
  useEffect(() => {
    if (pinnedKey !== null && !buckets.some((bucket) => bucket.key === pinnedKey))
      setPinnedKey(buckets.at(-1)?.key ?? null);
  }, [buckets, pinnedKey]);

  const realMax = Math.max(
    0,
    ...columns.map((column) => Math.max(column.total, column.previous ?? 0)),
  );
  const pricedTurns = buckets.reduce((sum, bucket) => sum + bucket.metrics.pricedTurnCount, 0);
  const turnsReported = buckets.some((bucket) => bucket.metrics.reporting != null);
  const empty =
    metric === "cost"
      ? pricedTurns === 0
        ? "No priced activity in this range"
        : null
      : metric === "turns"
        ? !turnsReported
          ? "Recorded turns are unavailable from this server."
          : realMax === 0
            ? "No recorded turns in retained data"
            : null
        : realMax === 0
          ? "No token totals were reported in this range."
          : null;
  if (empty || columns.length === 0)
    return (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        {empty ?? "No data in this range."}
      </div>
    );

  const step = niceStep(realMax, metric === "turns");
  const tickMax = step * 3;
  // Drawing uses at least one unit so an all-zero priced range stays finite.
  const drawMax = Math.max(tickMax, metric === "cost" ? 0.01 : 1);
  const ticks = step > 0 ? [0, 1, 2, 3].map((index) => step * index) : [0];

  const focusColumn = (index: number) => {
    const clamped = Math.min(lastIndex, Math.max(0, index));
    setActiveKey(columns[clamped]!.bucket.key);
    setTooltipOpen(true);
    columnRefs.current[clamped]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: activeIndex - 1,
      ArrowRight: activeIndex + 1,
      Home: 0,
      End: lastIndex,
    };
    if (event.key in moves) {
      event.preventDefault();
      focusColumn(moves[event.key]!);
    } else if (event.key === "Escape") {
      setPinnedKey(null);
      setTooltipOpen(false);
    }
  };
  // Map x to the nearest bucket over the full plot height, so zero-valued
  // buckets stay selectable.
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * columns.length);
    setActiveKey(columns[Math.min(lastIndex, Math.max(0, index))]!.bucket.key);
    setTooltipOpen(true);
  };
  const active = columns[activeIndex]!;
  const pinned = pinnedIndex === null ? null : columns[pinnedIndex]!;
  const legend =
    metric === "tokens" ? (
      <ChartLegend />
    ) : metric === "cost" ? (
      <ChartLegend segments={COST_SEGMENTS} label="Cost chart legend" />
    ) : null;

  return (
    <>
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="relative h-52 shrink-0 text-right text-2xs tabular-nums text-muted-foreground"
        >
          {ticks.map((tick, index) => (
            <span
              key={index}
              className="absolute right-0 block translate-y-1/2 whitespace-nowrap"
              style={{ bottom: `${(index / 3) * 100}%` }}
            >
              {formatValue(tick, metric)}
            </span>
          ))}
          <span className="invisible block whitespace-nowrap">{formatValue(tickMax, metric)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            ref={plotRef}
            role="group"
            aria-label={`${label} (${timeZone})`}
            className="relative h-52 rounded-lg border border-border/70 bg-muted/20"
            style={{ touchAction: "pan-y" }}
            onKeyDown={onKeyDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setTooltipOpen(false)}
          >
            {ticks.slice(1).map((tick, index) => (
              <div
                key={tick}
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/60"
                style={{ bottom: `${((index + 1) / 3) * 100}%` }}
              />
            ))}
            <div className="absolute inset-0 flex items-end">
              {columns.map((column, index) => (
                <button
                  key={column.bucket.key}
                  ref={(element) => {
                    columnRefs.current[index] = element;
                  }}
                  type="button"
                  data-chart-column=""
                  tabIndex={index === activeIndex ? 0 : -1}
                  aria-label={`${column.interval}: ${column.segments
                    .map((segment) => `${segment.label} ${formatValue(segment.value, metric)}`)
                    .join(", ")}. ${[...bucketDetails(column.bucket), previousLabel(column)]
                    .filter(Boolean)
                    .join(". ")}`}
                  aria-pressed={pinnedIndex === index}
                  className={cn(
                    "relative flex h-full min-w-0 flex-1 items-end px-[min(1px,15%)] outline-none focus-visible:bg-primary/10",
                    index === activeIndex && tooltipOpen && "bg-primary/5",
                  )}
                  onFocus={() => {
                    setActiveKey(column.bucket.key);
                    setTooltipOpen(true);
                  }}
                  onBlur={() => setTooltipOpen(false)}
                  onClick={() => {
                    setActiveKey(column.bucket.key);
                    setPinnedKey((current) =>
                      current === column.bucket.key ? null : column.bucket.key,
                    );
                  }}
                >
                  <span
                    data-chart-bar=""
                    className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                    style={{
                      height: `${column.total === 0 ? 0 : Math.max(1, (column.total / drawMax) * 100)}%`,
                    }}
                  >
                    {column.segments.map((segment) => (
                      <span
                        key={segment.key}
                        className={cn("block w-full", segment.color)}
                        style={{
                          height: `${column.total ? (segment.value / column.total) * 100 : 0}%`,
                        }}
                      />
                    ))}
                  </span>
                  {column.previous !== null ? (
                    <span
                      aria-hidden="true"
                      data-testid="usage-chart-previous"
                      className="pointer-events-none absolute inset-x-[8%] h-0.5 translate-y-1/2 rounded-full bg-foreground/60"
                      style={{ bottom: `${Math.min(100, (column.previous / drawMax) * 100)}%` }}
                    />
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <Tooltip open={tooltipOpen}>
            <TooltipPopup anchor={columnRefs.current[activeIndex] ?? null} side="top">
              <div className="space-y-0.5 py-0.5" data-testid="usage-chart-tooltip">
                <p className="font-medium">{active.interval}</p>
                {active.segments.map((segment) => (
                  <p key={segment.key}>
                    {segment.label}: {formatValue(segment.value, metric)}
                  </p>
                ))}
                <div className="mt-1 space-y-0.5 border-t border-border/50 pt-1 opacity-80">
                  {bucketDetails(active.bucket).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {previousLabel(active) ? <p>{previousLabel(active)}</p> : null}
                </div>
              </div>
            </TooltipPopup>
          </Tooltip>
          <div aria-hidden="true" className="mt-1 flex">
            {columns.map((column, index) => (
              <span
                key={column.bucket.key}
                className={cn(
                  "h-4 min-w-0 flex-1 truncate text-center text-2xs text-muted-foreground",
                  !(
                    columns.length <= 24 ||
                    index === 0 ||
                    index === columns.length - 1 ||
                    index % Math.ceil(columns.length / 8) === 0
                  ) && "invisible",
                )}
              >
                {column.bucket.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {legend}
      {previous ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-foreground/60" />
          Previous period
        </p>
      ) : null}
      {pinned ? (
        <section
          aria-label="Selected interval details"
          className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-border/70 p-3 text-xs"
        >
          <Button
            variant="ghost"
            className="min-h-11 min-w-11"
            aria-label="Previous interval"
            disabled={pinnedIndex === 0}
            onClick={() => {
              const key = columns[Math.max(0, pinnedIndex! - 1)]!.bucket.key;
              setPinnedKey(key);
              setActiveKey(key);
            }}
          >
            <ChevronLeftIcon aria-hidden="true" className="size-4" />
          </Button>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="font-medium text-foreground">{pinned.interval}</p>
            {bucketDetails(pinned.bucket).map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
            {previousLabel(pinned) ? (
              <p className="text-muted-foreground">{previousLabel(pinned)}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            className="min-h-11 min-w-11"
            aria-label="Next interval"
            disabled={pinnedIndex === lastIndex}
            onClick={() => {
              const key = columns[Math.min(lastIndex, pinnedIndex! + 1)]!.bucket.key;
              setPinnedKey(key);
              setActiveKey(key);
            }}
          >
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </Button>
        </section>
      ) : null}
      <Collapsible className="mt-3">
        <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          Show data table
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 max-h-72 overflow-auto">
            <table className={usageTableClasses.table}>
              <caption className="sr-only">{label} data</caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className={usageTableClasses.compactHeadCell}>Interval</th>
                  <th className={cn(usageTableClasses.compactHeadCell, "text-right")}>Tokens</th>
                  <th className={cn(usageTableClasses.compactHeadCell, "text-right")}>Cost</th>
                  <th className={cn(usageTableClasses.compactHeadCell, "text-right")}>
                    Recorded turns
                  </th>
                </tr>
              </thead>
              <tbody>
                {columns.map((column) => {
                  const tokens = tokenFieldDisplay(column.bucket.metrics, "totalTokens");
                  const metrics = column.bucket.metrics;
                  const priced =
                    metrics.providerReportedCostUsd !== null || metrics.pricedTurnCount > 0;
                  return (
                    <tr key={column.bucket.key} className={usageTableClasses.compactRow}>
                      <td className={usageTableClasses.compactCell}>{column.interval}</td>
                      <td className={cn(usageTableClasses.compactCell, usageTableClasses.numeric)}>
                        {tokens.value}
                        {tokens.detail ? ` (${tokens.detail})` : ""}
                      </td>
                      <td className={cn(usageTableClasses.compactCell, usageTableClasses.numeric)}>
                        {priced
                          ? formatUsd(
                              (metrics.providerReportedCostUsd ?? 0) +
                                (metrics.estimatedCostUsd ?? 0),
                            )
                          : "Unpriced"}
                      </td>
                      <td className={cn(usageTableClasses.compactCell, usageTableClasses.numeric)}>
                        {metrics.reporting ? metrics.reporting.recordedTurnCount : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}
