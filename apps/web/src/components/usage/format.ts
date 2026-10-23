import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UsageBucket,
  type UsageMetrics,
  type UsageRange,
  type UsageSummary,
} from "@t3tools/contracts";

/**
 * The browser's time zone for usage buckets, or UTC when the system reports a zone this
 * runtime cannot format (a misconfigured or retired name). The server rejects such a zone,
 * which failed the whole summary instead of bucketing it in UTC.
 */
export function resolveUsageTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}

export const RANGES: ReadonlyArray<{ readonly value: UsageRange; readonly label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

export const rangeLabel = (range: UsageRange) =>
  RANGES.find((option) => option.value === range)?.label ?? range;

export const providerLabel = (provider: ProviderKind) => PROVIDER_DISPLAY_NAMES[provider];

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

export function formatUsd(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value);
}

export type TokenField =
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "totalTokens";

const REPORTING_FIELD = {
  inputTokens: "inputTokenTurnCount",
  outputTokens: "outputTokenTurnCount",
  cacheReadTokens: "cacheReadTokenTurnCount",
  cacheWriteTokens: "cacheWriteTokenTurnCount",
  totalTokens: "totalTokenTurnCount",
} as const;

export interface FieldDisplay {
  /** Display value: a number, "0", "Unreported", or "Unknown". */
  readonly value: string;
  /** Coverage qualifier, or null when the value is complete. */
  readonly detail: string | null;
  /** True when at least one value was reported (so the number is meaningful). */
  readonly known: boolean;
  readonly complete: boolean;
}

/**
 * The one presentation rule for token fields: "Unreported" when nothing was
 * reported, a confirmed `0` only when values were reported, and a partial
 * subtotal with "N of M recorded turns". Older servers without field
 * coverage never show a confirmed zero for existing records.
 */
export function tokenFieldDisplay(metrics: UsageMetrics, field: TokenField): FieldDisplay {
  const value = metrics[field];
  const reporting = metrics.reporting;
  if (!reporting) {
    if (value > 0)
      return {
        value: compactNumber(value),
        detail: "Field coverage unavailable",
        known: true,
        complete: false,
      };
    return metrics.turnCount > 0
      ? { value: "Unknown", detail: "Field coverage unavailable", known: false, complete: false }
      : { value: "0", detail: null, known: true, complete: true };
  }
  const reported = reporting[REPORTING_FIELD[field]];
  const recorded = reporting.recordedTurnCount;
  if (reported === 0)
    // Legacy cost records carry no token fields, so cost-only history is
    // unreported rather than a confirmed zero.
    return recorded === 0 && reporting.legacyCostEventCount === 0
      ? { value: "0", detail: null, known: true, complete: true }
      : { value: "Unreported", detail: null, known: false, complete: false };
  const partial = reported < recorded;
  return {
    value: value === 0 ? "0" : compactNumber(value),
    detail: partial ? `${reported} of ${recorded} recorded turns` : null,
    known: true,
    complete: !partial,
  };
}

/** Totals are comparable only when every recorded turn reported a total. */
export function hasCompleteTotals(metrics: UsageMetrics): boolean {
  const reporting = metrics.reporting;
  return reporting != null && reporting.totalTokenTurnCount === reporting.recordedTurnCount;
}

export interface RecordCountDisplay {
  readonly label: "Recorded turns" | "Usage records";
  readonly count: number;
  /** Legacy cost-bearing events, never called turns. Null for older servers. */
  readonly legacyCostEvents: number | null;
}

export function recordCountDisplay(metrics: UsageMetrics): RecordCountDisplay {
  return metrics.reporting
    ? {
        label: "Recorded turns",
        count: metrics.reporting.recordedTurnCount,
        legacyCostEvents: metrics.reporting.legacyCostEventCount,
      }
    : { label: "Usage records", count: metrics.turnCount, legacyCostEvents: null };
}

export function totalCost(metrics: UsageMetrics): number {
  return (metrics.providerReportedCostUsd ?? 0) + (metrics.estimatedCostUsd ?? 0);
}

/** No provider-reported cost and no priced turn: the cost is unknown, not zero. */
export function isCostUnknown(metrics: UsageMetrics): boolean {
  return metrics.providerReportedCostUsd === null && !metrics.pricedTurnCount;
}

/** The value a row ranks and shares by for the selected chart metric. */
export function usageMetricValue(
  metrics: UsageMetrics,
  metric: "tokens" | "cost" | "turns",
): number {
  if (metric === "cost") return totalCost(metrics);
  if (metric === "turns") return recordCountDisplay(metrics).count;
  return metrics.totalTokens;
}

export function costLabel(metrics: UsageMetrics): string {
  if (isCostUnknown(metrics)) return "Unpriced";
  const estimates = metrics.estimatedCostUsd !== undefined && metrics.estimatedCostUsd !== null;
  return `${formatUsd(totalCost(metrics))}${estimates ? " (includes estimates)" : ""}${
    metrics.unpricedTurnCount > 0 ? " + unpriced" : ""
  }`;
}

/** "+23% vs previous 7 days", "New vs previous 7 days", or null to hide. */
export function formatDelta(current: number, previous: number, period: string): string | null {
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return `New vs previous ${period}`;
  const percent = Math.round(((current - previous) / previous) * 100);
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "";
  return `${sign}${Math.abs(percent)}% vs previous ${period}`;
}

export function tokenDelta(summary: UsageSummary): string | null {
  const previous = summary.previousMetrics;
  if (!previous || !hasCompleteTotals(summary.metrics) || !hasCompleteTotals(previous)) return null;
  return formatDelta(summary.metrics.totalTokens, previous.totalTokens, rangeLabel(summary.range));
}

export function costDelta(summary: UsageSummary): string | null {
  const previous = summary.previousMetrics;
  if (!previous || summary.metrics.pricedTurnCount === 0 || previous.pricedTurnCount === 0)
    return null;
  return formatDelta(totalCost(summary.metrics), totalCost(previous), rangeLabel(summary.range));
}

/**
 * Share of input served from cache, over composition with known totals:
 * cacheRead / (uncachedInput + cacheRead + cacheWrite). Null when no input.
 */
export function cacheRateText(summary: UsageSummary): string | null {
  let cacheRead = 0;
  let denominator = 0;
  for (const bucket of summary.buckets) {
    const composition = bucket.composition;
    if (!composition) continue;
    cacheRead += composition.cacheReadTokens;
    denominator +=
      composition.uncachedInputTokens + composition.cacheReadTokens + composition.cacheWriteTokens;
  }
  if (denominator === 0) return null;
  const reporting = summary.metrics.reporting;
  // A rate is only as covered as both the totals and the cache-read field.
  if (reporting && reporting.cacheReadTokenTurnCount === 0) return null;
  const covered = reporting
    ? Math.min(reporting.totalTokenTurnCount, reporting.cacheReadTokenTurnCount)
    : null;
  const qualifier =
    reporting && covered !== null && covered < reporting.recordedTurnCount
      ? ` · ${covered} of ${reporting.recordedTurnCount} recorded turns`
      : "";
  return `${Math.round((cacheRead / denominator) * 100)}% of input served from cache${qualifier}`;
}

/** Bucket end, derived for older responses from the next bucket or `generatedAt`. */
export function bucketEndAt(
  buckets: ReadonlyArray<UsageBucket>,
  index: number,
  generatedAt: string,
): string {
  return buckets[index]?.endAt ?? buckets[index + 1]?.startAt ?? generatedAt;
}

export function formatBucketInterval(input: {
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
  readonly hourly: boolean;
}): string {
  try {
    if (input.hourly) {
      const time = new Intl.DateTimeFormat(undefined, {
        timeZone: input.timeZone,
        hour: "numeric",
        minute: "2-digit",
      });
      const day = new Intl.DateTimeFormat(undefined, {
        timeZone: input.timeZone,
        month: "short",
        day: "numeric",
      });
      const offset = new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        timeZoneName: "shortOffset",
      })
        .formatToParts(new Date(input.startAt))
        .find((part) => part.type === "timeZoneName")?.value;
      return `${day.format(new Date(input.startAt))}, ${time.format(
        new Date(input.startAt),
      )} – ${time.format(new Date(input.endAt))}${offset ? ` ${offset}` : ""}`;
    }
    return new Intl.DateTimeFormat(undefined, {
      timeZone: input.timeZone,
      dateStyle: "medium",
    }).format(new Date(input.startAt));
  } catch {
    return input.startAt;
  }
}
