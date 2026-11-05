import type { CodexAccountDailyUsageBucket, UsageRange } from "@t3tools/contracts";

const DAY_MS = 86_400_000;
/** The daily chart always shows at least two weeks so short ranges keep context. */
export const CODEX_DAILY_CHART_MIN_DAYS = 14;

export function usageRangeDays(range: UsageRange): number {
  return range === "24h" ? 1 : Number.parseInt(range, 10);
}

/** Tokens per valid UTC calendar date; malformed or impossible dates are dropped. */
export function codexTokensByDate(
  buckets: ReadonlyArray<CodexAccountDailyUsageBucket>,
): Map<string, bigint> {
  const byDate = new Map<string, bigint>();
  for (const bucket of buckets) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)) continue;
    const date = new Date(`${bucket.startDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== bucket.startDate)
      continue;
    byDate.set(bucket.startDate, (byDate.get(bucket.startDate) ?? 0n) + BigInt(bucket.tokens));
  }
  return byDate;
}

/** The `days` UTC dates ending on `fetchedAt`'s UTC date, oldest first. */
function utcDatesEndingAt(fetchedAt: string, days: number): Array<string> {
  const last = new Date(fetchedAt);
  last.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) =>
    new Date(last.getTime() - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** Account tokens over the range's UTC calendar days; null when no bucket falls in it. */
export function codexAccountRangeTokens(input: {
  readonly fetchedAt: string;
  readonly dailyUsageBuckets: ReadonlyArray<CodexAccountDailyUsageBucket>;
  readonly range: UsageRange;
}): string | null {
  const byDate = codexTokensByDate(input.dailyUsageBuckets);
  let total = 0n;
  let found = false;
  for (const date of utcDatesEndingAt(input.fetchedAt, usageRangeDays(input.range))) {
    const tokens = byDate.get(date);
    if (tokens === undefined) continue;
    total += tokens;
    found = true;
  }
  return found ? total.toString() : null;
}

export interface CodexDailyTokenDay {
  readonly date: string;
  /** Exact decimal count for display. */
  readonly tokens: string;
  /** Approximate count, for bar heights only. */
  readonly value: number;
  readonly inRange: boolean;
  readonly reported: boolean;
}

/**
 * The last `max(rangeDays, 14)` UTC days, missing days as zero. Null when no
 * shown day has a bucket.
 */
export function codexDailyTokenSeries(input: {
  readonly fetchedAt: string;
  readonly dailyUsageBuckets: ReadonlyArray<CodexAccountDailyUsageBucket>;
  readonly range: UsageRange;
}): { readonly days: ReadonlyArray<CodexDailyTokenDay>; readonly peakDate: string | null } | null {
  const byDate = codexTokensByDate(input.dailyUsageBuckets);
  const rangeDays = usageRangeDays(input.range);
  const shown = Math.max(rangeDays, CODEX_DAILY_CHART_MIN_DAYS);
  const dates = utcDatesEndingAt(input.fetchedAt, shown);
  let peak: { date: string; tokens: bigint } | null = null;
  const days = dates.map((date, index) => {
    const tokens = byDate.get(date);
    if (tokens !== undefined && tokens > 0n && (!peak || tokens > peak.tokens))
      peak = { date, tokens };
    return {
      date,
      tokens: (tokens ?? 0n).toString(),
      value: Number(tokens ?? 0n),
      inRange: index >= shown - rangeDays,
      reported: tokens !== undefined,
    };
  });
  if (!days.some((day) => day.reported)) return null;
  return { days, peakDate: (peak as { date: string } | null)?.date ?? null };
}
