import type { IsoDateTime, UsageRange } from "@t3tools/contracts";

/** One chart interval: inclusive `startAt`, exclusive `endAt`. */
export interface UsageBucketDescriptor {
  readonly key: string;
  readonly label: string;
  readonly startAt: IsoDateTime;
  readonly endAt: IsoDateTime;
}

export interface UsageBucketPlan {
  readonly startedAt: IsoDateTime;
  /** Exclusive query end (one millisecond after `now`). */
  readonly endedAt: IsoDateTime;
  readonly buckets: ReadonlyArray<UsageBucketDescriptor>;
  /** Next natural bucket boundary, independent of the clipped query end. */
  readonly nextBucketAt: IsoDateTime;
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const RANGE_DAY_COUNTS: Record<Exclude<UsageRange, "24h">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const HOUR_MS = 3_600_000;
// Modern IANA offsets and transitions fall on UTC quarter hours, so every
// local-hour boundary is one of these candidate instants.
const STEP_MS = 15 * 60_000;

export class UsageTimeZoneError extends Error {
  constructor(readonly timeZone: string) {
    super(`Unsupported IANA time zone: ${timeZone}`);
  }
}

function formatterForParts(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function dateParts(date: Date, formatter: Intl.DateTimeFormat): DateParts {
  const values = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

function localDateKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = dateParts(date, formatter);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function addLocalCalendarDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${shifted.getUTCFullYear().toString().padStart(4, "0")}-${(shifted.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${shifted.getUTCDate().toString().padStart(2, "0")}`;
}

function localMidnightToUtc(key: string, formatter: Intl.DateTimeFormat): Date {
  const [year, month, day] = key.split("-").map(Number);
  const desiredAsUtc = Date.UTC(year!, month! - 1, day!, 0, 0, 0);
  let lower = desiredAsUtc - 36 * HOUR_MS;
  let upper = desiredAsUtc + 36 * HOUR_MS;
  // Find the first UTC instant represented by the requested local date. This
  // also handles zones that skip local midnight during a DST transition.
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (localDateKey(new Date(midpoint), formatter) < key) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }
  return new Date(lower);
}

export function assertUsageTimeZone(timeZone: string): Intl.DateTimeFormat {
  try {
    const formatter = formatterForParts(timeZone);
    formatter.format(new Date(0));
    return formatter;
  } catch {
    throw new UsageTimeZoneError(timeZone);
  }
}

interface LocalHour {
  /** Local wall-clock date and hour, e.g. `2026-11-01T01`. */
  readonly wallHour: string;
  readonly minute: number;
  readonly offsetMinutes: number;
}

function localHour(epochMs: number, formatter: Intl.DateTimeFormat): LocalHour {
  const parts = dateParts(new Date(epochMs), formatter);
  // `hourCycle: "h23"` can still report midnight as 24 in some engines.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  const offsetMinutes = Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
  return {
    wallHour: `${parts.year}-${parts.month}-${parts.day}T${hour}`,
    minute: parts.minute,
    offsetMinutes,
  };
}

function sameInterval(left: LocalHour, right: LocalHour): boolean {
  return left.wallHour === right.wallHour && left.offsetMinutes === right.offsetMinutes;
}

function isBoundary(epochMs: number, formatter: Intl.DateTimeFormat): boolean {
  return !sameInterval(localHour(epochMs, formatter), localHour(epochMs - STEP_MS, formatter));
}

function hourLabel(startMs: number, timeZone: string, formatter: Intl.DateTimeFormat): string {
  const start = localHour(startMs, formatter);
  const ambiguous = [-HOUR_MS, HOUR_MS].some((delta) => {
    const neighbor = localHour(startMs + delta, formatter);
    return neighbor.wallHour === start.wallHour && neighbor.offsetMinutes !== start.offsetMinutes;
  });
  const detailed = start.minute !== 0 || ambiguous;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    ...(detailed ? { minute: "2-digit", timeZoneName: "shortOffset" } : {}),
  } as Intl.DateTimeFormatOptions).format(new Date(startMs));
}

function planHourly(now: Date, timeZone: string, formatter: Intl.DateTimeFormat): UsageBucketPlan {
  const nowMs = now.getTime();
  const endedAt = new Date(nowMs + 1).toISOString();
  const boundaries: Array<number> = [];
  // Walk back over quarter-hour candidates; a boundary is where the local
  // hour or the UTC offset changes, so repeated DST hours stay separate.
  for (
    let candidate = Math.floor(nowMs / STEP_MS) * STEP_MS;
    boundaries.length < 24 && candidate > nowMs - 30 * HOUR_MS;
    candidate -= STEP_MS
  ) {
    if (isBoundary(candidate, formatter)) boundaries.push(candidate);
  }
  let next = Math.floor(nowMs / STEP_MS) * STEP_MS + STEP_MS;
  while (!isBoundary(next, formatter) && next < nowMs + 3 * HOUR_MS) next += STEP_MS;
  const starts = [...boundaries].reverse();
  const buckets = starts.map((startMs, index) => {
    const startAt = new Date(startMs).toISOString();
    return {
      key: startAt,
      label: hourLabel(startMs, timeZone, formatter),
      startAt,
      endAt: index === starts.length - 1 ? endedAt : new Date(starts[index + 1]!).toISOString(),
    };
  });
  return {
    startedAt: buckets[0]!.startAt,
    endedAt,
    buckets,
    nextBucketAt: new Date(next).toISOString(),
  };
}

function planDaily(
  now: Date,
  range: Exclude<UsageRange, "24h">,
  timeZone: string,
  formatter: Intl.DateTimeFormat,
): UsageBucketPlan {
  const count = RANGE_DAY_COUNTS[range];
  const endedAt = new Date(now.getTime() + 1).toISOString();
  const todayKey = localDateKey(now, formatter);
  const firstKey = addLocalCalendarDays(todayKey, -(count - 1));
  const labelFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  const keys = Array.from({ length: count + 1 }, (_, index) =>
    addLocalCalendarDays(firstKey, index),
  );
  const starts = keys.map((key) => localMidnightToUtc(key, formatter));
  const buckets = keys.slice(0, count).map((key, index) => ({
    key,
    label: labelFormatter.format(starts[index]!),
    startAt: starts[index]!.toISOString(),
    endAt: index === count - 1 ? endedAt : starts[index + 1]!.toISOString(),
  }));
  return {
    startedAt: buckets[0]!.startAt,
    endedAt,
    buckets,
    nextBucketAt: starts[count]!.toISOString(),
  };
}

/**
 * Plans the chart intervals for a range in the requested IANA zone: the 24
 * most recent local-hour intervals for `24h`, local calendar days otherwise.
 * The final bucket is clipped at the exclusive request end.
 */
export function planUsageBuckets(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly now: Date;
}): UsageBucketPlan {
  const formatter = assertUsageTimeZone(input.timeZone);
  return input.range === "24h"
    ? planHourly(input.now, input.timeZone, formatter)
    : planDaily(input.now, input.range, input.timeZone, formatter);
}
