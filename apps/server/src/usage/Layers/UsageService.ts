import {
  type IsoDateTime,
  type ProviderKind,
  type UsageBucket,
  type UsageGetSummaryInput,
  type UsageMetrics,
  type UsageProviderBreakdown,
  type UsageRange,
  type UsageSummary,
} from "@t3tools/contracts";
import { Clock, Effect, Layer, Schema } from "effect";

import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import {
  UsageFactRepository,
  type HourlyUsageFactSummary,
} from "../../persistence/Services/UsageFacts.ts";
import { UsageQueryError, UsageService, type UsageServiceShape } from "../Services/UsageService.ts";

interface MutableMetrics {
  turnCount: number;
  reportedTokenTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  providerReportedCostUsd: number;
  pricedTurnCount: number;
  unpricedTurnCount: number;
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

function emptyMetrics(): MutableMetrics {
  return {
    turnCount: 0,
    reportedTokenTurnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerReportedCostUsd: 0,
    pricedTurnCount: 0,
    unpricedTurnCount: 0,
  };
}

function addMetrics(target: MutableMetrics, row: HourlyUsageFactSummary): void {
  target.turnCount += row.turnCount;
  target.reportedTokenTurnCount += row.reportedTokenTurnCount;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.cacheWriteTokens += row.cacheWriteTokens;
  target.totalTokens += row.totalTokens;
  target.providerReportedCostUsd += row.providerReportedCostUsd ?? 0;
  target.pricedTurnCount += row.pricedTurnCount;
  target.unpricedTurnCount += row.unpricedTurnCount;
}

function freezeMetrics(metrics: MutableMetrics): UsageMetrics {
  return {
    ...metrics,
    providerReportedCostUsd: metrics.pricedTurnCount > 0 ? metrics.providerReportedCostUsd : null,
  };
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
  let lower = desiredAsUtc - 36 * 3_600_000;
  let upper = desiredAsUtc + 36 * 3_600_000;
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

function assertTimeZone(timeZone: string): Intl.DateTimeFormat {
  try {
    const formatter = formatterForParts(timeZone);
    formatter.format(new Date(0));
    return formatter;
  } catch {
    throw new UsageQueryError({ message: `Unsupported IANA time zone: ${timeZone}` });
  }
}

export function resolveUsageRangeWindow(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly now: Date;
}): { readonly startedAt: IsoDateTime; readonly endedAt: IsoDateTime } {
  const formatter = assertTimeZone(input.timeZone);
  if (input.range === "24h") {
    const end = input.now.getTime();
    const currentHour = Math.floor(end / 3_600_000) * 3_600_000;
    return {
      startedAt: new Date(currentHour - 23 * 3_600_000).toISOString(),
      endedAt: new Date(end + 1).toISOString(),
    };
  }
  const todayKey = localDateKey(input.now, formatter);
  const firstKey = addLocalCalendarDays(todayKey, -(RANGE_DAY_COUNTS[input.range] - 1));
  return {
    startedAt: localMidnightToUtc(firstKey, formatter).toISOString(),
    endedAt: new Date(input.now.getTime() + 1).toISOString(),
  };
}

function makeEmptyBuckets(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly now: Date;
  readonly formatter: Intl.DateTimeFormat;
}): Array<UsageBucket> {
  if (input.range === "24h") {
    const currentHour = Math.floor(input.now.getTime() / 3_600_000) * 3_600_000;
    const labelFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: input.timeZone,
      hour: "numeric",
    });
    return Array.from({ length: 24 }, (_, index) => {
      const startAt = new Date(currentHour - (23 - index) * 3_600_000);
      return {
        key: startAt.toISOString(),
        label: labelFormatter.format(startAt),
        startAt: startAt.toISOString(),
        metrics: freezeMetrics(emptyMetrics()),
      };
    });
  }

  const count = RANGE_DAY_COUNTS[input.range];
  const todayKey = localDateKey(input.now, input.formatter);
  const firstKey = addLocalCalendarDays(todayKey, -(count - 1));
  const labelFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    month: "short",
    day: "numeric",
  });
  return Array.from({ length: count }, (_, index) => {
    const key = addLocalCalendarDays(firstKey, index);
    const startAt = localMidnightToUtc(key, input.formatter);
    return {
      key,
      label: labelFormatter.format(startAt),
      startAt: startAt.toISOString(),
      metrics: freezeMetrics(emptyMetrics()),
    };
  });
}

function bucketKeyForRow(
  row: HourlyUsageFactSummary,
  range: UsageRange,
  formatter: Intl.DateTimeFormat,
): string {
  return range === "24h" ? row.hourStartedAt : localDateKey(new Date(row.hourStartedAt), formatter);
}

export function buildUsageSummary(input: {
  readonly request: UsageGetSummaryInput;
  readonly now: Date;
  readonly coverageStartedAt: IsoDateTime;
  readonly rangeStartedAt: IsoDateTime;
  readonly rows: ReadonlyArray<HourlyUsageFactSummary>;
}): UsageSummary {
  const formatter = assertTimeZone(input.request.timeZone);
  const emptyBuckets = makeEmptyBuckets({
    range: input.request.range,
    timeZone: input.request.timeZone,
    now: input.now,
    formatter,
  });
  const bucketMetrics = new Map(emptyBuckets.map((bucket) => [bucket.key, emptyMetrics()]));
  const totalMetrics = emptyMetrics();
  const providerMetrics = new Map<string, MutableMetrics>();
  const providerIdentity = new Map<string, { provider: ProviderKind; model: string | null }>();
  const providerAggregate = new Map<ProviderKind, MutableMetrics>();
  let historicalCostTurnCount = 0;

  for (const row of input.rows) {
    const bucket = bucketMetrics.get(bucketKeyForRow(row, input.request.range, formatter));
    if (!bucket) continue;
    addMetrics(bucket, row);
    addMetrics(totalMetrics, row);
    historicalCostTurnCount += row.historicalCostTurnCount;

    const identityKey = `${row.provider}\u0000${row.model ?? ""}`;
    const metrics = providerMetrics.get(identityKey) ?? emptyMetrics();
    addMetrics(metrics, row);
    providerMetrics.set(identityKey, metrics);
    providerIdentity.set(identityKey, { provider: row.provider as ProviderKind, model: row.model });

    const aggregate = providerAggregate.get(row.provider as ProviderKind) ?? emptyMetrics();
    addMetrics(aggregate, row);
    providerAggregate.set(row.provider as ProviderKind, aggregate);
  }

  const buckets = emptyBuckets.map((bucket) => ({
    ...bucket,
    metrics: freezeMetrics(bucketMetrics.get(bucket.key) ?? emptyMetrics()),
  }));
  const byProvider: Array<UsageProviderBreakdown> = Array.from(providerMetrics.entries())
    .map(([key, metrics]) => ({
      ...providerIdentity.get(key)!,
      metrics: freezeMetrics(metrics),
    }))
    .sort(
      (left, right) =>
        right.metrics.totalTokens - left.metrics.totalTokens ||
        (right.metrics.providerReportedCostUsd ?? 0) -
          (left.metrics.providerReportedCostUsd ?? 0) ||
        left.provider.localeCompare(right.provider) ||
        (left.model ?? "").localeCompare(right.model ?? ""),
    );
  const providersMissingTokens = Array.from(providerAggregate.entries())
    .filter(([, metrics]) => metrics.reportedTokenTurnCount < metrics.turnCount)
    .map(([provider]) => provider)
    .sort();
  const providersMissingCost = Array.from(providerAggregate.entries())
    .filter(([, metrics]) => metrics.unpricedTurnCount > 0)
    .map(([provider]) => provider)
    .sort();

  return {
    range: input.request.range,
    timeZone: input.request.timeZone,
    generatedAt: input.now.toISOString(),
    metrics: freezeMetrics(totalMetrics),
    buckets,
    byProvider,
    coverage: {
      coverageStartedAt: input.coverageStartedAt,
      rangeStartedAt: input.rangeStartedAt,
      partialHistory: input.rangeStartedAt < input.coverageStartedAt,
      historicalCostTurnCount,
      tokenUnreportedTurnCount: totalMetrics.turnCount - totalMetrics.reportedTokenTurnCount,
      costUnreportedTurnCount: totalMetrics.unpricedTurnCount,
      providersMissingTokens,
      providersMissingCost,
    },
  };
}

const make = Effect.gen(function* () {
  const repository = yield* UsageFactRepository;

  const getSummary: UsageServiceShape["getSummary"] = (request) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const window = yield* Effect.try({
        try: () =>
          resolveUsageRangeWindow({ range: request.range, timeZone: request.timeZone, now }),
        catch: (error) =>
          Schema.is(UsageQueryError)(error)
            ? error
            : new UsageQueryError({ message: `Unsupported IANA time zone: ${request.timeZone}` }),
      });
      const [coverageStartedAt, rows] = yield* Effect.all(
        [repository.readCoverageStartedAt, repository.summarizeHourly(window)],
        { concurrency: 2 },
      );
      return buildUsageSummary({
        request,
        now,
        coverageStartedAt,
        rangeStartedAt: window.startedAt,
        rows,
      });
    });

  return { getSummary } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, make).pipe(
  Layer.provide(UsageFactRepositoryLive),
);
