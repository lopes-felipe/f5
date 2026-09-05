import { ServerConfig } from "../../config.ts";
import {
  type UsageTokenComposition,
  type UsageAccount,
  type IsoDateTime,
  ProjectId,
  type ProviderKind,
  type UsageBucket,
  type UsageGetSummaryInput,
  type UsageMetrics,
  type UsageProviderBreakdown,
  type UsageRange,
  type UsageSummary,
} from "@t3tools/contracts";
import { parseLaunchArgv } from "@t3tools/shared/cliArgs";
import { Clock, Effect, Layer, Schema, Scope, Exit, Stream } from "effect";

import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  makeAccountUsageCapability,
  emptyAccountSection,
  type AccountUsageCapability,
} from "./AccountUsageService.ts";
import { readCodexControlEnvironmentConfig } from "../../codex/CodexControlClientRegistry.ts";
import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import {
  UsageFactRepository,
  type HourlyUsageFactSummary,
} from "../../persistence/Services/UsageFacts.ts";
import { toCodexProviderStartOptions } from "../../provider/codexProviderOptions.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { probeCodexAccountSections } from "../codexAccountUsage.ts";
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

  for (const row of input.rows) {
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
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;

  const registry = yield* ProviderInstanceRegistry;
  const permits = yield* Semaphore.make(2);
  const parentScope = yield* Effect.scope;
  const configurationLock = yield* Semaphore.make(1);
  let codex:
    | { key: string; scope: Scope.Closeable; capability: AccountUsageCapability }
    | undefined;
  const configureCodex = configurationLock.withPermits(1)(
    Effect.gen(function* () {
      const settings = (yield* serverSettings.getSettings).providers.codex;
      const key = JSON.stringify(settings);
      if (codex?.key === key) return codex.capability;
      if (codex) yield* Scope.close(codex.scope, Exit.void);
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(parentScope, Scope.close(scope, Exit.void));
      // Account data has its own five-minute cache. Each attempt owns a dedicated
      // process so configuration retirement cannot leave pooled RPC work running.
      const read = Effect.gen(function* () {
        const parsed = parseLaunchArgv(settings.launchArgs);
        if (!parsed.ok) return yield* Effect.fail(new Error("Invalid executable configuration"));
        const providerOptions = toCodexProviderStartOptions({
          binaryPath: settings.binaryPath,
          homePath: settings.homePath || undefined,
          launchArgs: parsed.argv,
        });
        return yield* probeCodexAccountSections(
          readCodexControlEnvironmentConfig(
            {
              projectId: ProjectId.makeUnsafe("f5-account-usage"),
              ...(providerOptions ? { providerOptions } : {}),
            },
            serverConfig.cwd,
          ),
        );
      });
      const capability = yield* makeAccountUsageCapability(
        {
          key: "codex:default",
          provider: "codex",
          providerInstanceId: null,
          displayName: "Codex — default configuration",
          enabled: settings.enabled,
          refreshState: "idle",
          sections: [emptyAccountSection("codex-tokens"), emptyAccountSection("codex-limits")],
        },
        read,
        { readerOwnsTimeout: true },
      ).pipe(Effect.provideService(Scope.Scope, scope));
      codex = { key, scope, capability };
      return capability;
    }),
  );
  yield* Stream.runForEach(serverSettings.streamChanges, () =>
    configureCodex.pipe(Effect.ignore),
  ).pipe(Effect.forkScoped);
  const getAccounts: UsageServiceShape["getAccounts"] = (request) =>
    Effect.gen(function* () {
      const defaultCodex = yield* configureCodex;
      const instances = yield* registry.listInstances;
      const capabilities = [
        defaultCodex,
        ...instances.flatMap((instance) => (instance.accountUsage ? [instance.accountUsage] : [])),
      ];
      yield* Effect.forEach(capabilities, (capability) =>
        capability.refresh(request.refresh, permits),
      );
      const snapshots = yield* Effect.forEach(capabilities, (capability) => capability.getSnapshot);
      const unavailable = yield* registry.listUnavailable;
      const shadows: Array<UsageAccount> = unavailable
        .filter((entry) => entry.driver === "claudeAgent")
        .map((entry) => ({
          key: `claude:${entry.instanceId}`,
          provider: "claudeAgent",
          providerInstanceId: entry.instanceId,
          displayName: entry.displayName ?? "Claude",
          enabled: entry.enabled,
          refreshState: "idle",
          sections: [{ ...emptyAccountSection("claude-usage"), errorCode: "temporary-failure" }],
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
      return buildUsageSummary({
        request,
        now,
        coverageStartedAt,
        rangeStartedAt: window.startedAt,
        rows,
      });
    });

  return { getSummary, getAccounts } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, make).pipe(
  Layer.provide(UsageFactRepositoryLive),
);
