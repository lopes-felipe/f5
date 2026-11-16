import { makeResetCreditCoordinator } from "../resetCredits.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type UsageAccount,
  type IsoDateTime,
  type ProviderKind,
  type ServerProvider,
  type UsageRange,
  USAGE_THREAD_TURNS_LIMIT,
} from "@t3tools/contracts";
import { Clock, Effect, Layer, Schema } from "effect";

import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { emptyAccountSection } from "./AccountUsageService.ts";
import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import { UsageFactRepository } from "../../persistence/Services/UsageFacts.ts";
import { UsageAccountHistoryRepositoryLive } from "../../persistence/Layers/UsageAccountHistory.ts";
import { UsageAccountHistoryRepository } from "../../persistence/Services/UsageAccountHistory.ts";
import { makeAccountHistoryRecorder } from "../accountHistory.ts";
import { buildQuotaHistory, QUOTA_HISTORY_LOOKBACK_MS } from "../quotaHistory.ts";
import { makeQuotaSampler } from "../quotaSampler.ts";
import { UsageQueryError, UsageService, type UsageServiceShape } from "../Services/UsageService.ts";
import type { AccountUsageErrorCode } from "@t3tools/contracts";
import { externalMuseHistory, museHistoryBuckets } from "../museHistory.ts";
import { recordedMusePredicate } from "../museRecordedIntervals.ts";

const CLAUDE_USAGE_ANALYSIS_ERRORS: Partial<Record<AccountUsageErrorCode, string>> = {
  unsupported: "This Claude version cannot analyze usage.",
  "authentication-required": "Sign in to Claude to analyze usage.",
  timeout: "Usage analysis took longer than a minute and was stopped.",
  "process-unavailable": "Claude could not run the usage analysis.",
};
import { planUsageBuckets, UsageTimeZoneError, type UsageBucketPlan } from "../usageBuckets.ts";
import {
  aggregateUsageMetrics,
  applyModelAliases,
  resolveModelAliases,
  aggregateUsageScope,
  buildPreviousBuckets,
  previousBucketWindows,
  buildUsageProjectScope,
  buildUsageSummary,
  previousUsageWindow,
} from "../usageSummary.ts";

function planOrFail(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly now: Date;
}): UsageBucketPlan {
  try {
    return planUsageBuckets(input);
  } catch (error) {
    if (error instanceof UsageTimeZoneError) throw new UsageQueryError({ message: error.message });
    throw error;
  }
}

export function resolveUsageRangeWindow(input: {
  readonly range: UsageRange;
  readonly timeZone: string;
  readonly now: Date;
}): { readonly startedAt: IsoDateTime; readonly endedAt: IsoDateTime } {
  const plan = planOrFail(input);
  return { startedAt: plan.startedAt, endedAt: plan.endedAt };
}

const SHADOW_DRIVERS = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "muse",
];

function shadowAccounts(unavailable: ReadonlyArray<ServerProvider>): Array<UsageAccount> {
  return unavailable
    .filter((entry) => SHADOW_DRIVERS.includes(entry.driver))
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
      refreshState: "idle" as const,
      sections: (entry.driver === "codex"
        ? [emptyAccountSection("codex-tokens"), emptyAccountSection("codex-limits")]
        : entry.driver === "claudeAgent"
          ? [emptyAccountSection("claude-usage")]
          : [emptyAccountSection("provider-limits")]
      ).map((section) => ({ ...section, errorCode: "temporary-failure" as const })),
    }));
}

const make = Effect.gen(function* () {
  const repository = yield* UsageFactRepository;
  const historyRepository = yield* UsageAccountHistoryRepository;
  const recorder = yield* makeAccountHistoryRecorder;
  const settingsService = yield* ServerSettingsService;
  const redeem = yield* makeResetCreditCoordinator;
  const registry = yield* ProviderInstanceRegistry;
  const permits = yield* Semaphore.make(2);
  const refreshAccount: UsageServiceShape["refreshAccount"] = (instanceId) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(instanceId);
      const capability = instance?.accountUsage;
      if (!instance?.enabled || !capability) return { snapshot: null, fresh: false };
      if (capability.refreshAccount) {
        const result = yield* capability.refreshAccount(permits);
        // Observe but return live state, so resume logic never sees hydrated data.
        yield* recorder.observe(result.snapshot, capability.identity);
        return result;
      }
      return { snapshot: yield* capability.getSnapshot, fresh: false };
    });
  const analyzeClaudeUsage: UsageServiceShape["analyzeClaudeUsage"] = (input) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(input.providerInstanceId);
      if (!instance?.enabled || !instance.analyzeClaudeUsage)
        return yield* new UsageQueryError({
          message: "This account does not support usage analysis.",
        });
      return yield* instance.analyzeClaudeUsage(permits).pipe(
        Effect.mapError(
          (error) =>
            new UsageQueryError({
              message: CLAUDE_USAGE_ANALYSIS_ERRORS[error.code] ?? "Usage analysis failed.",
            }),
        ),
      );
    });
  const consumeResetCredit: UsageServiceShape["consumeResetCredit"] = (input) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(input.providerInstanceId);
      if (!instance?.enabled || !instance.consumeResetCredit)
        return yield* Effect.fail(
          new UsageQueryError({ message: "This account does not support reset credits." }),
        );
      const result = yield* redeem(
        input,
        // The coordinator passes the grant the pending key was first sent for.
        (key, grantId) =>
          instance.consumeResetCredit!(key, grantId).pipe(
            // The request stays pending; say why it failed instead of a generic error.
            Effect.mapError(
              (error) =>
                new UsageQueryError({
                  message: `${error.detail} The claim stays pending; retry to check it.`,
                }),
            ),
          ),
        instance.resetCreditIdentity,
      );
      // The redemption route owns the awaited refresh and uses its freshness
      // result to update scheduled resumes. Refreshing here would discard that
      // result and throttle the route's refresh immediately afterward.
      return result;
    });
  const getAccounts: UsageServiceShape["getAccounts"] = (request) =>
    Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      if (request.providerInstanceId !== undefined) {
        const instance = instances.find((entry) => entry.instanceId === request.providerInstanceId);
        if (!instance?.accountUsage)
          return yield* new UsageQueryError({
            message: "The selected provider instance does not support account usage.",
          });
        const snapshot = yield* instance.accountUsage.getSnapshot;
        if (!snapshot.enabled)
          return yield* new UsageQueryError({
            message: "The selected provider instance is disabled.",
          });
      }
      const capabilities = instances.flatMap((instance) =>
        instance.accountUsage ? [instance.accountUsage] : [],
      );
      yield* Effect.forEach(instances, (instance) =>
        instance.accountUsage &&
        (request.providerInstanceId === undefined ||
          request.providerInstanceId === instance.instanceId)
          ? instance.accountUsage.refresh(request.refresh, permits)
          : Effect.void,
      );
      const snapshots = yield* Effect.forEach(capabilities, (capability) =>
        capability.getSnapshot.pipe(
          Effect.tap((snapshot) => recorder.observe(snapshot, capability.identity)),
        ),
      );
      const shadows = shadowAccounts(yield* registry.listUnavailable);
      return [
        ...snapshots.map((snapshot, index) =>
          recorder.hydrate(snapshot, capabilities[index]!.identity),
        ),
        ...shadows.map((shadow) => recorder.hydrate(shadow, null)),
      ];
    }).pipe(
      Effect.mapError(() => new UsageQueryError({ message: "Account settings are unavailable." })),
    );

  const getSummary: UsageServiceShape["getSummary"] = (request) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const plan = yield* Effect.try({
        try: () => planOrFail({ range: request.range, timeZone: request.timeZone, now }),
        catch: (error) =>
          Schema.is(UsageQueryError)(error)
            ? error
            : new UsageQueryError({ message: `Unsupported IANA time zone: ${request.timeZone}` }),
      });
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => new UsageQueryError({ message: "Usage prices are unavailable." })),
      );
      const priceOverrides = settings.usagePriceOverrides;
      const modelAliases = resolveModelAliases(settings.usageModelAliases);
      const filters = {
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.hiddenProviders?.length ? { hiddenProviders: request.hiddenProviders } : {}),
        ...(request.projectId ? { projectId: request.projectId } : {}),
      };
      const instances = yield* registry.listInstances;
      const capabilities =
        (request.provider && request.provider !== "muse") ||
        request.hiddenProviders?.includes("muse")
          ? []
          : instances.flatMap((instance) =>
              instance.enabled && instance.usageHistory ? [instance.usageHistory] : [],
            );
      if (!request.projectId)
        yield* Effect.forEach(capabilities, (capability) => capability.refresh);
      const snapshots = yield* Effect.forEach(capabilities, (capability) => capability.getSnapshot);
      const sources = new Set<string>();
      const cachedHistory = snapshots
        .toSorted((a, b) => (b.refreshedAt ?? 0) - (a.refreshedAt ?? 0))
        .flatMap((snapshot) => {
          if (!snapshot.source || sources.has(snapshot.source)) return [];
          sources.add(snapshot.source);
          return snapshot.records;
        });
      // Reconcile every summary against fresh facts. A turn may have completed
      // since this snapshot was scanned, including while later refreshes fail.
      const nativeHistory = externalMuseHistory(
        cachedHistory,
        recordedMusePredicate(
          cachedHistory.length ? yield* repository.readMuseRecordedIntervals : [],
        ),
      );
      const nativeHistoryStatus = snapshots.some((snapshot) => snapshot.status === "refreshing")
        ? ("refreshing" as const)
        : snapshots.some((snapshot) => snapshot.status === "error")
          ? ("error" as const)
          : snapshots.some((snapshot) => snapshot.status === "ready")
            ? ("ready" as const)
            : ("idle" as const);
      const nativeHistoryError =
        nativeHistoryStatus === "error"
          ? snapshots.find((snapshot) => snapshot.errorMessage)?.errorMessage
          : undefined;
      const readBuckets: typeof repository.summarizeBuckets = (input) =>
        repository
          .summarizeBuckets(input)
          .pipe(
            Effect.map((rows) => [
              ...rows,
              ...(!input.projectId ? museHistoryBuckets(nativeHistory, input.buckets) : []),
            ]),
          );
      // SQLite executes synchronously, so these reads run sequentially.
      const metadata = yield* repository.readUsageMetadata;
      const rows = applyModelAliases(
        yield* readBuckets({ buckets: plan.buckets, ...filters }),
        modelAliases,
      );
      const scopeRows = applyModelAliases(
        [
          ...(yield* repository.summarizeByScope({
            startedAt: plan.startedAt,
            endedAt: plan.endedAt,
            ...(request.provider ? { provider: request.provider } : {}),
            ...(request.hiddenProviders?.length
              ? { hiddenProviders: request.hiddenProviders }
              : {}),
          })),
          ...museHistoryBuckets(nativeHistory, [
            { key: "scope", startAt: plan.startedAt, endAt: plan.endedAt },
          ]).map((row) => ({ ...row, threadId: null, projectId: null })),
        ],
        modelAliases,
      );
      const selectedProjectId = request.projectId ?? null;
      const aggregation = aggregateUsageScope({
        rows: scopeRows,
        projectId: selectedProjectId,
        priceOverrides,
      });
      const previous = previousUsageWindow({
        plan,
        coverageStartedAt: metadata.coverageStartedAt,
        factCutoverAt: metadata.factCutoverAt,
      });
      const previousMetrics = previous
        ? aggregateUsageMetrics(
            applyModelAliases(
              yield* readBuckets({
                buckets: [
                  { key: "previous", startAt: previous.startedAt, endAt: previous.endedAt },
                ],
                ...filters,
              }),
              modelAliases,
            ),
            priceOverrides,
          )
        : null;
      const previousBuckets = request.includePreviousBuckets
        ? yield* Effect.gen(function* () {
            const buckets = previousBucketWindows({
              currentPlan: plan,
              previousPlan: planOrFail({
                range: request.range,
                timeZone: request.timeZone,
                now: new Date(Date.parse(plan.startedAt) - 1),
              }),
              coverageStartedAt: metadata.coverageStartedAt,
              factCutoverAt: metadata.factCutoverAt,
            });
            if (!buckets) return null;
            return buildPreviousBuckets({
              buckets,
              rows: applyModelAliases(yield* readBuckets({ buckets, ...filters }), modelAliases),
              priceOverrides,
            });
          })
        : null;
      const titles = yield* repository.readScopeTitles({
        threadIds: aggregation.threads.map((thread) => thread.id),
        projectIds: aggregation.projects.flatMap((project) =>
          project.id === null ? [] : [project.id],
        ),
      });
      return {
        ...buildUsageSummary({
          priceOverrides,
          request,
          now,
          coverageStartedAt: metadata.coverageStartedAt,
          plan,
          rows,
          projectScope: buildUsageProjectScope({ aggregation, selectedProjectId, titles }),
          previousMetrics,
          previousBuckets,
        }),
        nativeHistoryStatus,
        ...(nativeHistoryError ? { nativeHistoryError } : {}),
      };
    });

  const getQuotaHistory: UsageServiceShape["getQuotaHistory"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* historyRepository.listSamplesSince(
      new Date(now - QUOTA_HISTORY_LOOKBACK_MS).toISOString(),
    );
    return buildQuotaHistory(rows, new Date(now));
  }).pipe(Effect.mapError(() => new UsageQueryError({ message: "Quota history is unavailable." })));

  const getThreadTurns: UsageServiceShape["getThreadTurns"] = (input) =>
    repository
      .listByThread({ threadId: input.threadId, limit: USAGE_THREAD_TURNS_LIMIT })
      .pipe(Effect.mapError(() => new UsageQueryError({ message: "Turn usage is unavailable." })));

  const sampler = makeQuotaSampler({
    listInstances: registry.listInstances,
    listAccountKeys: Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      const current = yield* Effect.forEach(
        instances.flatMap((instance) => (instance.accountUsage ? [instance.accountUsage] : [])),
        (capability) => capability.getSnapshot.pipe(Effect.map((snapshot) => snapshot.key)),
      );
      const shadows = shadowAccounts(yield* registry.listUnavailable).map((shadow) => shadow.key);
      return [...current, ...shadows];
    }),
    enabled: settingsService.getSettings.pipe(
      Effect.map((settings) => settings.usageBackgroundSampling),
      // Unreadable settings must not start background probing.
      Effect.orElseSucceed(() => false),
    ),
    permits,
    recorder,
    prune: historyRepository.prune,
  });
  yield* sampler.run.pipe(Effect.forkScoped);

  return {
    getSummary,
    getAccounts,
    consumeResetCredit,
    refreshAccount,
    getQuotaHistory,
    analyzeClaudeUsage,
    getThreadTurns,
  } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, make).pipe(
  Layer.provide(Layer.mergeAll(UsageFactRepositoryLive, UsageAccountHistoryRepositoryLive)),
);
