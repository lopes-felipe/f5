import { makeResetCreditCoordinator } from "../resetCredits.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type UsageAccount,
  type IsoDateTime,
  type ProviderKind,
  type ServerProvider,
  type UsageRange,
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
import { planUsageBuckets, UsageTimeZoneError, type UsageBucketPlan } from "../usageBuckets.ts";
import {
  aggregateUsageMetrics,
  applyModelAliases,
  resolveModelAliases,
  aggregateUsageScope,
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
      // The redemption route owns the awaited refresh and uses its freshness
      // result to update scheduled resumes. Refreshing here would discard that
      // result and throttle the route's refresh immediately afterward.
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
      // SQLite executes synchronously, so these reads run sequentially.
      const metadata = yield* repository.readUsageMetadata;
      const rows = applyModelAliases(
        yield* repository.summarizeBuckets({ buckets: plan.buckets, ...filters }),
        modelAliases,
      );
      const scopeRows = applyModelAliases(
        yield* repository.summarizeByScope({
          startedAt: plan.startedAt,
          endedAt: plan.endedAt,
          ...(request.provider ? { provider: request.provider } : {}),
          ...(request.hiddenProviders?.length ? { hiddenProviders: request.hiddenProviders } : {}),
        }),
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
              yield* repository.summarizeBuckets({
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
      const titles = yield* repository.readScopeTitles({
        threadIds: aggregation.threads.map((thread) => thread.id),
        projectIds: aggregation.projects.flatMap((project) =>
          project.id === null ? [] : [project.id],
        ),
      });
      return buildUsageSummary({
        priceOverrides,
        request,
        now,
        coverageStartedAt: metadata.coverageStartedAt,
        plan,
        rows,
        projectScope: buildUsageProjectScope({ aggregation, selectedProjectId, titles }),
        previousMetrics,
      });
    });

  const getQuotaHistory: UsageServiceShape["getQuotaHistory"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* historyRepository.listSamplesSince(
      new Date(now - QUOTA_HISTORY_LOOKBACK_MS).toISOString(),
    );
    return buildQuotaHistory(rows, new Date(now));
  }).pipe(Effect.mapError(() => new UsageQueryError({ message: "Quota history is unavailable." })));

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
  } satisfies UsageServiceShape;
});

export const UsageServiceLive = Layer.effect(UsageService, make).pipe(
  Layer.provide(Layer.mergeAll(UsageFactRepositoryLive, UsageAccountHistoryRepositoryLive)),
);
