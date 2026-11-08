import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AccountUsageSection,
  type UsageTurnFact,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import Migration0001 from "../../persistence/Migrations/001_OrchestrationEvents.ts";
import Migration0005 from "../../persistence/Migrations/005_Projections.ts";
import Migration0068 from "../../persistence/Migrations/068_UsageFacts.ts";
import Migration0071 from "../../persistence/Migrations/071_UsageEventTimeIndex.ts";
import Migration0073 from "../../persistence/Migrations/073_UsageFactRecordedAt.ts";
import Migration0116 from "../../persistence/Migrations/116_UsageAccountHistory.ts";
import { UsageFactRepository } from "../../persistence/Services/UsageFacts.ts";
import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { UsageService } from "../Services/UsageService.ts";
import { emptyAccountSection, makeAccountUsageCapability } from "./AccountUsageService.ts";
import { UsageServiceLive } from "./UsageService.ts";

const instanceId = ProviderInstanceId.make("claude-live");
let probeFails = false;

const available = (fetchedAt: string): AccountUsageSection => ({
  kind: "claude-usage",
  outcome: "available",
  lastAttemptAt: fetchedAt,
  errorCode: null,
  snapshot: {
    fetchedAt,
    data: {
      subscriptionLabel: null,
      limitsAvailable: true,
      windows: [{ key: "five_hour", label: "5-hour limit", utilization: 30, resetsAt: null }],
      extraUsage: null,
    },
  },
});

/** A registry whose instance is rebuilt per layer, simulating a server restart. */
const registryLayer = Layer.effect(
  ProviderInstanceRegistry,
  Effect.gen(function* () {
    const capability = yield* makeAccountUsageCapability(
      {
        key: `claude:${instanceId}`,
        provider: "claudeAgent",
        providerInstanceId: instanceId,
        displayName: "Claude",
        enabled: true,
        refreshState: "idle",
        sections: [emptyAccountSection("claude-usage")],
      },
      Effect.suspend(() =>
        probeFails
          ? Effect.fail(new Error("offline"))
          : Effect.succeed([available("2026-10-15T10:00:00.000Z")]),
      ),
      { identity: "claude:identity" },
    );
    const instance = {
      instanceId,
      enabled: true,
      accountUsage: capability,
    } as unknown as ProviderInstance;
    return {
      getInstance: (id: ProviderInstanceId) =>
        Effect.succeed(id === instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      changes: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } as unknown as typeof ProviderInstanceRegistry.Service;
  }),
);

const serviceLayer = UsageServiceLive.pipe(
  Layer.provide(Layer.mergeAll(registryLayer, ServerSettingsService.layerTest())),
);

it.layer(SqliteClient.layerMemory())("UsageService account history", (it) => {
  it.effect("persists live snapshots and hydrates them after a restart", () =>
    Effect.gen(function* () {
      yield* Migration0116;
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const result = yield* usage.refreshAccount(instanceId);
        assert.equal(result.snapshot?.sections[0]?.outcome, "available");
      }).pipe(Effect.provide(serviceLayer));

      probeFails = true;
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const [account] = yield* usage.getAccounts({ refresh: "none" });
        const section = account!.sections[0]!;
        assert.equal(section.snapshot?.fetchedAt, "2026-10-15T10:00:00.000Z");
        assert.equal(section.lastAttemptAt, null);

        // refreshAccount returns live, un-hydrated state for resume logic.
        const refreshed = yield* usage.refreshAccount(instanceId);
        assert.equal(refreshed.snapshot?.sections[0]?.snapshot, null);
        assert.equal(refreshed.fresh, false);
      }).pipe(Effect.provide(serviceLayer));
    }),
  );
});

function fact(
  id: string,
  completedAt: string,
  overrides: Partial<UsageTurnFact> = {},
): UsageTurnFact {
  return {
    turnId: TurnId.makeUnsafe(`turn-${id}`),
    threadId: ThreadId.makeUnsafe("thread-a"),
    projectId: ProjectId.makeUnsafe("project-a"),
    provider: "codex",
    providerInstanceId: null,
    model: "gpt-5.6",
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    totalTokens: 100,
    providerReportedCostUsd: null,
    tokenProvenance: "provider-reported",
    costProvenance: "unreported",
    completedAt,
    sourceEventId: EventId.makeUnsafe(`event-${id}`),
    ...overrides,
  };
}

it.layer(SqliteClient.layerMemory())("UsageService summaries", (it) => {
  it.effect("applies the provider and project filters to the previous period", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0116;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-01-01T00:00:00.000Z',
            fact_cutover_at = '2026-01-01T00:00:00.000Z'
      `;
      const facts = yield* UsageFactRepository;
      // Previous 7-day window: 2026-08-06 .. 2026-08-13.
      yield* facts.record(fact("prev-a", "2026-08-10T00:00:00.000Z", { totalTokens: 100 }));
      yield* facts.record(
        fact("prev-b", "2026-08-10T00:00:00.000Z", {
          totalTokens: 1_000,
          projectId: ProjectId.makeUnsafe("project-b"),
        }),
      );
      yield* facts.record(
        fact("prev-claude", "2026-08-10T00:00:00.000Z", {
          totalTokens: 10_000,
          provider: "claudeAgent",
        }),
      );
      yield* facts.record(fact("now-a", "2026-08-19T00:00:00.000Z", { totalTokens: 150 }));
      yield* TestClock.setTime(Date.parse("2026-08-20T00:00:00.000Z"));

      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const all = yield* usage.getSummary({ range: "7d", timeZone: "UTC" });
        assert.equal(all.previousMetrics?.totalTokens, 11_100);
        const filtered = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          provider: "codex",
          projectId: ProjectId.makeUnsafe("project-a"),
        });
        assert.equal(filtered.metrics.totalTokens, 150);
        assert.equal(filtered.previousMetrics?.totalTokens, 100);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );

  it.effect("returns index-aligned previous buckets only when requested", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0116;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-01-01T00:00:00.000Z',
            fact_cutover_at = '2026-01-01T00:00:00.000Z'
      `;
      const facts = yield* UsageFactRepository;
      // Turn IDs are unique across this layer's shared database.
      yield* facts.record(fact("buckets-a", "2026-08-07T03:00:00.000Z", { totalTokens: 40 }));
      yield* facts.record(fact("buckets-b", "2026-08-13T22:00:00.000Z", { totalTokens: 60 }));
      yield* facts.record(
        fact("buckets-claude", "2026-08-11T00:00:00.000Z", {
          totalTokens: 500,
          provider: "claudeAgent",
        }),
      );
      // Late in the day, so the equal-duration previous window spans whole days too.
      yield* TestClock.setTime(Date.parse("2026-08-20T23:59:00.000Z"));

      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const plain = yield* usage.getSummary({ range: "7d", timeZone: "UTC" });
        assert.isNull(plain.previousBuckets);

        const compared = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          includePreviousBuckets: true,
        });
        const previous = compared.previousBuckets!;
        assert.equal(previous.length, compared.buckets.length);
        // Each previous bucket is the same local day one period earlier.
        compared.buckets.forEach((bucket, index) => {
          assert.equal(
            Date.parse(bucket.startAt) - Date.parse(previous[index]!.startAt),
            7 * 86_400_000,
          );
        });
        assert.equal(previous[0]!.key, "2026-08-07");
        assert.equal(previous[0]!.metrics.totalTokens, 40);
        assert.equal(previous.at(-1)!.metrics.totalTokens, 60);
        // Complete windows add up to the previous-period totals.
        assert.equal(
          previous.reduce((sum, bucket) => sum + bucket.metrics.totalTokens, 0),
          compared.previousMetrics?.totalTokens,
        );

        const filtered = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          provider: "codex",
          includePreviousBuckets: true,
        });
        // Filters apply to the previous buckets as they do to the previous totals.
        const allProviders = previous.reduce((sum, bucket) => sum + bucket.metrics.totalTokens, 0);
        const codexOnly = filtered.previousBuckets!.reduce(
          (sum, bucket) => sum + bucket.metrics.totalTokens,
          0,
        );
        assert.equal(codexOnly, filtered.previousMetrics?.totalTokens);
        assert.isBelow(codexOnly, allProviders);
        assert.equal(filtered.previousBuckets![4]!.metrics.totalTokens, 0);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );

  it.effect("omits previous buckets before complete coverage", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0116;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-15T00:00:00.000Z',
            fact_cutover_at = '2026-08-15T00:00:00.000Z'
      `;
      yield* TestClock.setTime(Date.parse("2026-08-20T00:00:00.000Z"));
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const summary = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          includePreviousBuckets: true,
        });
        assert.isNull(summary.previousBuckets);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});
