import type { UsageBucket, UsageMonthlyBudget } from "@t3tools/contracts";

import { isCostUnknown, totalCost } from "./format";

const HOUR_MS = 60 * 60_000;

function zonedParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

/** Offset of `timeZone` from UTC at an instant, in milliseconds. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = zonedParts(at, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (at - (at % 1000));
}

/** The instant of local midnight on a calendar day in `timeZone` (month is 1-based). */
export function zonedMidnightMs(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day);
  let result = guess - zoneOffsetMs(guess, timeZone);
  // A DST change between the guess and the result shifts the offset once.
  result = guess - zoneOffsetMs(result, timeZone);
  return result;
}

export interface MonthWindow {
  readonly startMs: number;
  readonly endMs: number;
  /** `YYYY-MM-01`, comparable with daily bucket keys. */
  readonly startKey: string;
  readonly endKey: string;
  readonly daysInMonth: number;
  /** The IANA zone the month boundaries are in, for formatting dates. */
  readonly timeZone: string;
}

export function monthWindow(nowMs: number, timeZone: string): MonthWindow {
  const { year, month } = zonedParts(nowMs, timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const key = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
  return {
    startMs: zonedMidnightMs(year, month, 1, timeZone),
    endMs: zonedMidnightMs(nextYear, nextMonth, 1, timeZone),
    startKey: key(year, month),
    endKey: key(nextYear, nextMonth),
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    timeZone,
  };
}

export interface MonthToDateUsage {
  readonly window: MonthWindow;
  readonly costUsd: number;
  readonly tokens: number;
  readonly unpricedTurnCount: number;
  /** Share of the month elapsed, 0–1. */
  readonly elapsedFraction: number;
  /** False in the first hour of the month, when a linear forecast is noise. */
  readonly canForecast: boolean;
}

/** Sums daily buckets (local `YYYY-MM-DD` keys) inside the current local month. */
export function monthToDateUsage(input: {
  readonly buckets: ReadonlyArray<UsageBucket>;
  readonly timeZone: string;
  readonly nowMs: number;
}): MonthToDateUsage {
  const window = monthWindow(input.nowMs, input.timeZone);
  let costUsd = 0;
  let tokens = 0;
  let unpricedTurnCount = 0;
  for (const bucket of input.buckets) {
    if (bucket.key < window.startKey || bucket.key >= window.endKey) continue;
    tokens += bucket.metrics.totalTokens;
    unpricedTurnCount += bucket.metrics.unpricedTurnCount;
    if (!isCostUnknown(bucket.metrics)) costUsd += totalCost(bucket.metrics);
  }
  const elapsedMs = Math.max(0, input.nowMs - window.startMs);
  const totalMs = window.endMs - window.startMs;
  return {
    window,
    costUsd,
    tokens,
    unpricedTurnCount,
    elapsedFraction: Math.min(1, elapsedMs / totalMs),
    canForecast: elapsedMs >= HOUR_MS,
  };
}

export interface BudgetMeter {
  readonly kind: "cost" | "tokens";
  readonly used: number;
  readonly limit: number;
  /** Projected month-end total at the month-to-date pace; null before it's meaningful. */
  readonly forecast: number | null;
  /** When the pace crosses the limit, if before month end and not yet crossed. */
  readonly exceedsAtMs: number | null;
  readonly exceeded: boolean;
  readonly forecastOver: boolean;
  /** Warning tone from a 90% forecast (or 90% used). */
  readonly warn: boolean;
}

function meter(
  kind: BudgetMeter["kind"],
  used: number,
  limit: number,
  usage: MonthToDateUsage,
): BudgetMeter {
  const { window, elapsedFraction, canForecast } = usage;
  const forecast = canForecast && elapsedFraction > 0 ? used / elapsedFraction : null;
  const exceeded = used > limit;
  const forecastOver = !exceeded && forecast !== null && forecast > limit;
  const exceedsAtMs =
    forecastOver && used > 0
      ? window.startMs + (limit / used) * elapsedFraction * (window.endMs - window.startMs)
      : null;
  return {
    kind,
    used,
    limit,
    forecast,
    exceedsAtMs,
    exceeded,
    forecastOver,
    warn: exceeded || (forecast ?? used) >= limit * 0.9 || used >= limit * 0.9,
  };
}

export function budgetMeters(
  budget: UsageMonthlyBudget | null,
  usage: MonthToDateUsage,
): Array<BudgetMeter> {
  if (!budget) return [];
  return [
    ...(budget.costUsd !== null && budget.costUsd > 0
      ? [meter("cost", usage.costUsd, budget.costUsd, usage)]
      : []),
    ...(budget.tokens !== null && budget.tokens > 0
      ? [meter("tokens", usage.tokens, budget.tokens, usage)]
      : []),
  ];
}

export function hasBudget(budget: UsageMonthlyBudget | null | undefined): boolean {
  return (
    budget != null &&
    ((budget.costUsd !== null && budget.costUsd > 0) ||
      (budget.tokens !== null && budget.tokens > 0))
  );
}
