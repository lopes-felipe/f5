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
import { Effect, Fiber, Layer, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageFactRepositoryLive } from "../../persistence/Layers/UsageFacts.ts";
import Migration0001 from "../../persistence/Migrations/001_OrchestrationEvents.ts";
import Migration0005 from "../../persistence/Migrations/005_Projections.ts";
import Migration0068 from "../../persistence/Migrations/068_UsageFacts.ts";
import Migration0071 from "../../persistence/Migrations/071_UsageEventTimeIndex.ts";
import Migration0073 from "../../persistence/Migrations/073_UsageFactRecordedAt.ts";
import Migration0161 from "../../persistence/Migrations/161_UsageNativeIdentity.ts";
import Migration0116 from "../../persistence/Migrations/116_UsageAccountHistory.ts";
import Migration0101 from "../../persistence/Migrations/101_UsageResetCreditRequests.ts";
import Migration0165 from "../../persistence/Migrations/165_UsageResetCreditGrant.ts";
import { UsageFactRepository } from "../../persistence/Services/UsageFacts.ts";
import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { UsageService } from "../Services/UsageService.ts";
import { emptyAccountSection, makeAccountUsageCapability } from "./AccountUsageService.ts";
import { UsageServiceLive } from "./UsageService.ts";
import { parseMuseHistoryLine } from "../museHistory.ts";
import { makeNativeHistoryCapability } from "../nativeHistory.ts";
import { readMuseHistory } from "../museHistory.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const instanceId = ProviderInstanceId.make("claude-live");

it.layer(SqliteClient.layerMemory())("Muse cached native accounting", (it) => {
  it.effect(
    "keeps missing usage, excludes newly completed facts, and retains independent child/review activity",
    () =>
      Effect.gen(function* () {
        yield* Migration0001;
        yield* Migration0005;
        yield* Migration0068;
        yield* Migration0071;
        yield* Migration0073;
        yield* Migration0161;
        yield* Migration0116;
        yield* TestClock.setTime(Date.parse("2026-08-20T23:59:00.000Z"));
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "muse-accounting-"))),
          (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
        );
        const envelope = (id: string, session: string, at: string, kind = "model_completed") => ({
          schema_version: 1,
          record_type: "event",
          payload_type: "runtime.session",
          payload_schema_version: 3,
          id,
          recorded_at: Date.parse(at) * 1000,
          stream: { kind: "session", id: session },
          payload: {
            event: { kind, model: "muse", usage: { input_tokens: 100, output_tokens: 20 } },
          },
        });
        yield* Effect.promise(async () => {
          const dir = path.join(home, "sessions", "parent");
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, "session.jsonl"),
            [
              envelope("external", "parent", "2026-08-20T11:00:00Z"),
              envelope("own", "parent", "2026-08-20T12:00:30Z"),
              envelope("child", "child", "2026-08-20T12:00:35Z"),
              envelope("review", "parent", "2026-08-20T12:00:40Z", "automated_review_completed"),
            ]
              .map((record) => JSON.stringify(record))
              .join("\n") + "\n",
          );
        });
        const records = yield* Effect.promise(() =>
          readMuseHistory(home, undefined, () => Date.parse("2026-08-20T23:59:00.000Z")),
        );
        let status: "idle" | "ready" | "error" = "idle";
        const registry = {
          listInstances: Effect.succeed([
            {
              enabled: true,
              usageHistory: {
                refresh: Effect.void,
                getSnapshot: Effect.sync(() => ({
                  source: home,
                  records: status === "idle" ? [] : records,
                  status,
                })),
              },
            },
          ]),
        } as unknown as typeof ProviderInstanceRegistry.Service;
        const facts = yield* UsageFactRepository;
        yield* Effect.gen(function* () {
          const usage = yield* UsageService;
          const summary = () => usage.getSummary({ range: "24h", timeZone: "UTC" });
          const idle = yield* usage.getSummary({
            range: "24h",
            timeZone: "UTC",
            projectId: ProjectId.make("project"),
          });
          assert.equal(idle.nativeHistoryStatus, "idle");
          status = "ready";
          assert.equal((yield* summary()).metrics.totalTokens, 480);
          const missing = {
            ...fact("cached-native", "2026-08-20T12:01:00.000Z"),
            provider: "muse" as const,
            nativeSessionId: "parent",
            startedAt: "2026-08-20T12:00:00.000Z",
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          };
          yield* facts.record(missing);
          assert.equal((yield* summary()).metrics.nativeInferenceCount, 4);
          yield* facts.record({ ...missing, inputTokens: 100, outputTokens: 20, totalTokens: 120 });
          const completed = yield* summary();
          assert.equal(completed.metrics.totalTokens, 480);
          assert.equal(completed.metrics.turnCount, 1);
          assert.equal(completed.metrics.nativeInferenceCount, 3);
          status = "error";
          assert.equal((yield* summary()).metrics.totalTokens, 480);
        }).pipe(
          Effect.provide(
            UsageServiceLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ProviderInstanceRegistry, registry),
                  ServerSettingsService.layerTest(),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("Muse history summary integration", (it) => {
  it.effect("an unresolved Muse handshake cannot block database results for other providers", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0161;
      yield* Migration0116;
      yield* TestClock.setTime(Date.parse("2026-08-20T23:59:00.000Z"));
      const facts = yield* UsageFactRepository;
      yield* facts.record(fact("unblocked", "2026-08-20T12:00:00.000Z"));
      const history = yield* makeNativeHistoryCapability({
        enabled: true,
        discover: Effect.never,
        scan: () => Effect.succeed([]),
      });
      const registry = {
        listInstances: Effect.succeed([{ enabled: true, usageHistory: history }]),
      } as unknown as typeof ProviderInstanceRegistry.Service;
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const pending = yield* usage
          .getSummary({ range: "24h", timeZone: "UTC" })
          .pipe(Effect.timeout("1 second"), Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        const summary = yield* Fiber.join(pending);
        assert.isAbove(summary.metrics.totalTokens, 0);
        assert.equal(summary.nativeHistoryStatus, "refreshing");
      }).pipe(
        Effect.provide(
          UsageServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderInstanceRegistry, registry),
                ServerSettingsService.layerTest(),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("Muse history merging", (it) => {
  it.effect(
    "merges native history once across accounts and applies date, provider and project filters",
    () =>
      Effect.gen(function* () {
        yield* Migration0001;
        yield* Migration0005;
        yield* Migration0068;
        yield* Migration0071;
        yield* Migration0073;
        yield* Migration0161;
        yield* Migration0116;
        yield* TestClock.setTime(Date.parse("2026-08-20T23:59:00.000Z"));
        const record = parseMuseHistoryLine(
          JSON.stringify({
            schema_version: 1,
            payload_schema_version: 3,
            record_type: "event",
            payload_type: "runtime.session",
            id: "review",
            recorded_at: Date.parse("2026-08-20T12:00:00Z") * 1000,
            stream: { kind: "session", id: "child" },
            payload: {
              event: {
                kind: "automated_review_completed",
                model: "unpriced-muse",
                usage: { input_tokens: 100, output_tokens: 20 },
              },
            },
          }),
        )!;
        let refreshes = 0;
        const instance = {
          enabled: true,
          usageHistory: {
            refresh: Effect.sync(() => {
              refreshes++;
            }),
            getSnapshot: Effect.succeed({
              source: "/native/muse",
              records: [record],
              status: "ready",
            }),
          },
        } as unknown as ProviderInstance;
        const registry = {
          listInstances: Effect.succeed([instance, instance, { ...instance, enabled: false }]),
        } as unknown as typeof ProviderInstanceRegistry.Service;
        yield* Effect.gen(function* () {
          const usage = yield* UsageService;
          const all = yield* usage.getSummary({ range: "24h", timeZone: "UTC" });
          assert.equal(all.metrics.totalTokens, 120);
          assert.equal(all.metrics.turnCount, 0);
          assert.equal(all.metrics.nativeInferenceCount, 1);
          assert.equal(all.metrics.unpricedNativeInferenceCount, 1);
          assert.equal(
            all.buckets.reduce((sum, bucket) => sum + bucket.metrics.totalTokens, 0),
            120,
          );
          for (const filter of [
            { provider: "codex" as const },
            { hiddenProviders: ["muse" as const] },
            { projectId: ProjectId.make("other-project") },
          ]) {
            const filtered = yield* usage.getSummary({ range: "24h", timeZone: "UTC", ...filter });
            assert.equal(filtered.metrics.totalTokens, 0);
            if ("projectId" in filter)
              assert.isTrue(
                filtered.projectScope?.byProject.some((project) => project.projectId === null),
              );
          }
          assert.equal(refreshes, 2);
        }).pipe(
          Effect.provide(
            UsageServiceLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ProviderInstanceRegistry, registry),
                  ServerSettingsService.layerTest(),
                ),
              ),
            ),
          ),
        );
      }),
  );
});

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

it.layer(SqliteClient.layerMemory())("UsageService reset credits", (it) => {
  it.effect("passes the Claude grant id through to the instance", () =>
    Effect.gen(function* () {
      yield* Migration0101;
      yield* Migration0165;
      const calls: Array<[string, string | undefined]> = [];
      const instance = {
        instanceId,
        enabled: true,
        resetCreditIdentity: "claude:identity",
        consumeResetCredit: (key: string, grantId?: string) =>
          Effect.sync(() => {
            calls.push([key, grantId]);
            return { outcome: "reset" as const };
          }),
      } as unknown as ProviderInstance;
      const registry = Layer.succeed(ProviderInstanceRegistry, {
        getInstance: (id: ProviderInstanceId) =>
          Effect.succeed(id === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        changes: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as typeof ProviderInstanceRegistry.Service);
      const result = yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        return yield* usage.consumeResetCredit({
          providerInstanceId: instanceId,
          idempotencyKey: "key-1",
          grantId: "fable_reset",
        });
      }).pipe(
        Effect.provide(
          UsageServiceLive.pipe(
            Layer.provide(Layer.mergeAll(registry, ServerSettingsService.layerTest())),
          ),
        ),
      );
      assert.deepStrictEqual(result, { outcome: "reset" });
      assert.deepStrictEqual(calls, [["key-1", "fable_reset"]]);
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

it.layer(SqliteClient.layerMemory())("UsageService thread turns", (it) => {
  it.effect("returns only the requested thread's turns, oldest first", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0116;
      yield* Migration0161;
      const facts = yield* UsageFactRepository;
      yield* facts.record(fact("thread-late", "2026-08-12T10:05:00.000Z", { cacheReadTokens: 70 }));
      yield* facts.record(fact("thread-early", "2026-08-12T10:00:00.000Z"));
      yield* facts.record(
        fact("thread-other", "2026-08-12T10:01:00.000Z", {
          threadId: ThreadId.makeUnsafe("thread-b"),
        }),
      );

      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const result = yield* usage.getThreadTurns({ threadId: ThreadId.makeUnsafe("thread-a") });
        assert.deepStrictEqual(
          result.turns.map((turn) => `${turn.turnId}:${turn.cacheReadTokens}`),
          ["turn-thread-early:0", "turn-thread-late:70"],
        );
        assert.equal(result.firstTurnId, "turn-thread-early");
        const empty = yield* usage.getThreadTurns({ threadId: ThreadId.makeUnsafe("thread-z") });
        assert.deepStrictEqual(empty, { turns: [], firstTurnId: null, earlierTurnCount: 0 });
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("UsageService summaries", (it) => {
  it.effect("applies the provider and project filters to the previous period", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0161;
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
      yield* Migration0161;
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
      yield* Migration0161;
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

  it.effect("gates previous buckets on their own first day, not the equal-length window", () =>
    Effect.gen(function* () {
      yield* Migration0001;
      yield* Migration0005;
      yield* Migration0068;
      yield* Migration0071;
      yield* Migration0073;
      yield* Migration0161;
      yield* Migration0116;
      const sql = yield* SqlClient.SqlClient;
      // Mid-day: the equal-length previous window starts around Aug 7 12:00,
      // after coverage, but the first previous bucket starts at Aug 7 00:00.
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-07T06:00:00.000Z',
            fact_cutover_at = '2026-08-07T06:00:00.000Z'
      `;
      yield* TestClock.setTime(Date.parse("2026-08-20T12:00:00.000Z"));
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const partial = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          includePreviousBuckets: true,
        });
        assert.isNotNull(partial.previousMetrics);
        assert.isNull(partial.previousBuckets);
      }).pipe(Effect.provide(serviceLayer));

      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-07T00:00:00.000Z',
            fact_cutover_at = '2026-08-07T00:00:00.000Z'
      `;
      yield* Effect.gen(function* () {
        const usage = yield* UsageService;
        const complete = yield* usage.getSummary({
          range: "7d",
          timeZone: "UTC",
          includePreviousBuckets: true,
        });
        assert.equal(complete.previousBuckets?.[0]?.startAt, "2026-08-07T00:00:00.000Z");
        assert.equal(complete.previousBuckets?.length, complete.buckets.length);
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});
