import { makeResetCreditCoordinator } from "../resetCredits.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type UsageTokenComposition,
  type UsageAccount,
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

import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { emptyAccountSection } from "./AccountUsageService.ts";
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
  estimatedCostUsd: number;
  estimatedTurnCount: number;
  reportedCostTurnCount: number;
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

function emptyComposition() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  };
}

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
    estimatedCostUsd: 0,
    estimatedTurnCount: 0,
    reportedCostTurnCount: 0,
    pricedTurnCount: 0,
    unpricedTurnCount: 0,
  };
}

function addMetrics(target: MutableMetrics, row: HourlyUsageFactSummary): void {
  target.reportedCostTurnCount += row.providerReportedCostUsd === null ? 0 : row.pricedTurnCount;
  target.estimatedTurnCount += row.estimatedCostUsd !== undefined ? row.turnCount : 0;
  target.estimatedCostUsd += row.estimatedCostUsd ?? 0;
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
    turnCount: metrics.turnCount,
    reportedTokenTurnCount: metrics.reportedTokenTurnCount,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    totalTokens: metrics.totalTokens,
    pricedTurnCount: metrics.pricedTurnCount,
    unpricedTurnCount: metrics.unpricedTurnCount,
    ...(metrics.estimatedTurnCount > 0 ? { estimatedCostUsd: metrics.estimatedCostUsd } : {}),
    providerReportedCostUsd:
      metrics.reportedCostTurnCount > 0 ? metrics.providerReportedCostUsd : null,
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
        composition: emptyComposition(),
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
      composition: emptyComposition(),
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
  readonly priceOverrides?: ReadonlyArray<import("@t3tools/contracts").UsagePriceOverride>;
}): UsageSummary {
  const formatter = assertTimeZone(input.request.timeZone);
  const emptyBuckets = makeEmptyBuckets({
    range: input.request.range,
    timeZone: input.request.timeZone,
    now: input.now,
    formatter,
  });
  const bucketMetrics = new Map(emptyBuckets.map((bucket) => [bucket.key, emptyMetrics()]));
  const compositions = new Map(emptyBuckets.map((bucket) => [bucket.key, emptyComposition()]));
  const totalMetrics = emptyMetrics();
  const providerMetrics = new Map<string, MutableMetrics>();
  const providerIdentity = new Map<string, { provider: ProviderKind; model: string | null }>();
  const providerAggregate = new Map<ProviderKind, MutableMetrics>();
  let historicalCostTurnCount = 0;

  for (const originalRow of input.rows) {
    const override = input.priceOverrides?.find(
      (price) => price.provider === originalRow.provider && price.model === originalRow.model,
    );
    const canEstimate =
      override &&
      originalRow.providerReportedCostUsd === null &&
      (originalRow.estimationEligibleTurnCount ?? originalRow.reportedTokenTurnCount) ===
        originalRow.turnCount &&
      originalRow.turnCount > 0;
    const row = canEstimate
      ? {
          ...originalRow,
          estimatedCostUsd:
            ((originalRow.provider === "claudeAgent"
              ? originalRow.inputTokens
              : Math.max(0, originalRow.inputTokens - originalRow.cacheReadTokens)) *
              override.inputUsdPerMillion +
              originalRow.outputTokens * override.outputUsdPerMillion +
              originalRow.cacheReadTokens *
                (override.cacheReadUsdPerMillion ?? override.inputUsdPerMillion) +
              (originalRow.provider === "claudeAgent" ? originalRow.cacheWriteTokens : 0) *
                (override.cacheWriteUsdPerMillion ?? override.inputUsdPerMillion)) /
            1_000_000,
          pricedTurnCount: originalRow.turnCount,
          unpricedTurnCount: 0,
        }
      : originalRow;
    const bucket = bucketMetrics.get(bucketKeyForRow(row, input.request.range, formatter));
    if (!bucket) continue;
    const composition = compositions.get(bucketKeyForRow(row, input.request.range, formatter))!;
    const segments: UsageTokenComposition = {
      uncachedInputTokens:
        row.provider === "claudeAgent"
          ? row.inputTokens
          : Math.max(0, row.inputTokens - row.cacheReadTokens),
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.provider === "claudeAgent" ? row.cacheWriteTokens : 0,
      unattributedTokens: 0,
    };
    const attributed = Object.values(segments).reduce((sum, value) => sum + value, 0);
    for (const key of Object.keys(segments) as Array<keyof UsageTokenComposition>)
      composition[key] += segments[key];
    composition.unattributedTokens += Math.max(0, row.totalTokens - attributed);
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
    composition: compositions.get(bucket.key) ?? emptyComposition(),
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
  const settingsService = yield* ServerSettingsService;
  const redeem = yield* makeResetCreditCoordinator;
  const registry = yield* ProviderInstanceRegistry;
  const permits = yield* Semaphore.make(2);
  const consumeResetCredit: UsageServiceShape["consumeResetCredit"] = (input) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(input.providerInstanceId);
      if (!instance?.enabled || !instance.consumeResetCredit)
        return yield* Effect.fail(
          new UsageQueryError({ message: "This account does not support reset credits." }),
        );
      const result = yield* redeem(
        input,
        (key) => instance.consumeResetCredit!(key),
        instance.resetCreditIdentity,
      );
      if (instance.accountUsage) yield* instance.accountUsage.refresh("force", permits);
      return result;
    });
  const getAccounts: UsageServiceShape["getAccounts"] = (request) =>
    Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      const capabilities = instances.flatMap((instance) =>
        instance.accountUsage ? [instance.accountUsage] : [],
      );
      yield* Effect.forEach(capabilities, (capability) =>
        capability.refresh(request.refresh, permits),
      );
      const snapshots = yield* Effect.forEach(capabilities, (capability) => capability.getSnapshot);
      const unavailable = yield* registry.listUnavailable;
      const shadows: Array<UsageAccount> = unavailable
        .filter((entry) =>
          ["claudeAgent", "codex", "cursor", "grok", "opencode", "antigravity"].includes(
            entry.driver,
          ),
        )
        .map((entry) => ({
          key: `${entry.driver === "claudeAgent" ? "claude" : entry.driver}:${entry.instanceId}`,
          provider: entry.driver as ProviderKind,
          providerInstanceId: entry.instanceId,
          displayName:
            entry.displayName ??
            (
              {
                codex: "Codex",
                claudeAgent: "Claude",
                cursor: "Cursor",
                grok: "Grok",
                opencode: "OpenCode",
                antigravity: "Antigravity",
              } as Record<string, string>
            )[entry.driver] ??
            entry.driver,
          enabled: entry.enabled,
          refreshState: "idle",
          sections: (entry.driver === "codex"
            ? [emptyAccountSection("codex-tokens"), emptyAccountSection("codex-limits")]
            : entry.driver === "claudeAgent"
              ? [emptyAccountSection("claude-usage")]
              : [emptyAccountSection("provider-limits")]
          ).map((section) => ({ ...section, errorCode: "temporary-failure" as const })),
        }));
      return [...snapshots, ...shadows];
    }).pipe(
      Effect.mapError(() => new UsageQueryError({ message: "Account settings are unavailable." })),
    );

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
        [
          repository.readCoverageStartedAt,
          repository.summarizeHourly({
            ...window,
            ...(request.provider ? { provider: request.provider } : {}),
          }),
        ],
        { concurrency: 2 },
      );
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => new UsageQueryError({ message: "Usage prices are unavailable." })),
      );
      return buildUsageSummary({
        priceOverrides: settings.usagePriceOverrides,
        request,
        now,
        coverageStartedAt,
        rangeStartedAt: window.startedAt,
        rows,
      });
    });

  return { getSummary, getAccounts, consumeResetCredit } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, make).pipe(
  Layer.provide(UsageFactRepositoryLive),
);
