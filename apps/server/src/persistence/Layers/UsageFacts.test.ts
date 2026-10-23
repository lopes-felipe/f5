import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId, TurnId, type UsageTurnFact } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0001 from "../Migrations/001_OrchestrationEvents.ts";
import Migration0005 from "../Migrations/005_Projections.ts";
import Migration0068 from "../Migrations/068_UsageFacts.ts";
import Migration0071 from "../Migrations/071_UsageEventTimeIndex.ts";
import Migration0073 from "../Migrations/073_UsageFactRecordedAt.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import { UsageFactRepository } from "../Services/UsageFacts.ts";
import { makeUsageBucketStatements, UsageFactRepositoryLive } from "./UsageFacts.ts";

const migrate = Effect.gen(function* () {
  yield* Migration0001;
  yield* Migration0005;
  yield* Migration0068;
  yield* Migration0071;
  yield* Migration0073;
});

const insertLegacyCost = (input: {
  readonly id: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      ) VALUES (
        ${input.id}, 'thread', 'stream', ${Math.floor(Math.random() * 1e9)},
        'thread.session-set', ${input.occurredAt}, NULL, NULL, NULL, 'provider',
        ${JSON.stringify(input.payload)}, '{}'
      )
    `;
  });

const insertThread = (threadId: string, projectId: string, title: string, deleted = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, created_at, last_interaction_at, updated_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, ${title}, 'model', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        ${deleted ? "2026-02-01T00:00:00.000Z" : null}
      )
    `;
  });

const insertProject = (projectId: string, title: string, deleted = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${title}, '/tmp', '[]', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', ${deleted ? "2026-02-01T00:00:00.000Z" : null}
      )
    `;
  });

function fact(overrides: Partial<UsageTurnFact> & { readonly id: string }): UsageTurnFact {
  const { id, ...rest } = overrides;
  return {
    turnId: TurnId.makeUnsafe(`turn-${id}`),
    threadId: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    provider: "codex",
    providerInstanceId: null,
    model: "gpt-5.6",
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: null,
    totalTokens: 100,
    providerReportedCostUsd: null,
    tokenProvenance: "provider-reported",
    costProvenance: "unreported",
    completedAt: "2026-08-12T10:30:00.000Z",
    sourceEventId: EventId.makeUnsafe(`event-${id}`),
    ...rest,
  };
}

const day = (key: string) => ({
  key,
  startAt: `${key}T00:00:00.000Z`,
  endAt: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86_400_000).toISOString(),
});

it.layer(SqliteClient.layerMemory())("UsageFactRepository facts and legacy costs", (it) => {
  it.effect("upserts facts idempotently and includes pre-cutover event-log costs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-10T00:00:00.000Z',
            fact_cutover_at = '2026-08-10T00:00:00.000Z'
        WHERE singleton_id = 1
      `;
      yield* insertThread("thread-1", "project-1", "Thread one");
      yield* insertThread("thread-2", "project-2", "Thread two");

      const repository = yield* UsageFactRepository;
      const current = fact({ id: "current" });
      yield* repository.record(current);
      yield* repository.record(current);
      // Exactly on a bucket boundary: belongs only to the later bucket.
      yield* repository.record(
        fact({
          id: "boundary",
          completedAt: "2026-08-12T00:00:00.000Z",
          threadId: ThreadId.makeUnsafe("thread-2"),
          projectId: ProjectId.makeUnsafe("project-2"),
          inputTokens: 0,
          outputTokens: null,
          cacheReadTokens: null,
          totalTokens: null,
          tokenProvenance: "unreported",
        }),
      );
      yield* insertLegacyCost({
        id: "legacy-no-thread",
        occurredAt: "2026-08-09T08:30:00.000Z",
        payload: { session: { providerName: "claudeAgent", turnCostUsd: 0.75 } },
      });
      yield* insertLegacyCost({
        id: "legacy-thread",
        occurredAt: "2026-08-09T09:30:00.000Z",
        payload: {
          threadId: "thread-2",
          session: { providerName: "claudeAgent", turnCostUsd: 0.25 },
        },
      });
      yield* insertLegacyCost({
        id: "legacy-no-cost",
        occurredAt: "2026-08-09T10:30:00.000Z",
        payload: { threadId: "thread-2", session: { providerName: "claudeAgent" } },
      });
      yield* insertLegacyCost({
        id: "legacy-negative",
        occurredAt: "2026-08-09T10:30:00.000Z",
        payload: { session: { providerName: "claudeAgent", turnCostUsd: -1 } },
      });

      const buckets = ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"].map(
        day,
      );
      const rows = yield* repository.summarizeBuckets({ buckets });
      for (const provider of ["codex", "claudeAgent", "cursor"] as const) {
        const filtered = yield* repository.summarizeBuckets({ buckets, provider });
        assert.deepStrictEqual(
          filtered,
          rows.filter((row) => row.provider === provider),
        );
      }
      // Hidden providers leave both facts and legacy cost events out.
      assert.deepStrictEqual(
        yield* repository.summarizeBuckets({ buckets, hiddenProviders: ["claudeAgent", "cursor"] }),
        rows.filter((row) => row.provider === "codex"),
      );
      assert.isTrue(rows.some((row) => row.provider === "claudeAgent" && row.legacyCostEventCount));
      const range = { startedAt: buckets[0]!.startAt, endedAt: buckets.at(-1)!.endAt };
      const scopeRows = yield* repository.summarizeByScope(range);
      assert.deepStrictEqual(
        yield* repository.summarizeByScope({ ...range, hiddenProviders: ["claudeAgent"] }),
        scopeRows.filter((row) => row.provider !== "claudeAgent"),
      );
      assert.isTrue(scopeRows.some((row) => row.provider === "claudeAgent"));
      assert.deepStrictEqual(
        rows.map((row) => ({
          bucket: row.bucketKey,
          provider: row.provider,
          turns: row.turnCount,
          recorded: row.recordedTurnCount,
          legacy: row.legacyCostEventCount,
          tokens: row.totalTokens,
          knownTotals: row.totalTokenTurnCount,
          knownInputs: row.inputTokenTurnCount,
          cost: row.providerReportedCostUsd,
        })),
        [
          {
            bucket: "2026-08-12",
            provider: "codex",
            turns: 1,
            recorded: 1,
            legacy: 0,
            tokens: 100,
            knownTotals: 1,
            knownInputs: 1,
            cost: null,
          },
          {
            bucket: "2026-08-12",
            provider: "codex",
            turns: 1,
            recorded: 1,
            legacy: 0,
            tokens: 0,
            knownTotals: 0,
            knownInputs: 1,
            cost: null,
          },
          {
            bucket: "2026-08-09",
            provider: "claudeAgent",
            turns: 2,
            recorded: 0,
            legacy: 2,
            tokens: 0,
            knownTotals: 0,
            knownInputs: 0,
            cost: 1,
          },
        ].sort((left, right) => (left.legacy ? 1 : 0) - (right.legacy ? 1 : 0)),
      );

      const projectTwo = yield* repository.summarizeBuckets({
        buckets,
        projectId: ProjectId.makeUnsafe("project-2"),
      });
      assert.deepStrictEqual(
        projectTwo.map((row) => [row.provider, row.turnCount, row.providerReportedCostUsd]),
        [
          ["codex", 1, null],
          ["claudeAgent", 1, 0.25],
        ],
      );

      const scope = yield* repository.summarizeByScope({
        startedAt: "2026-08-08T00:00:00.000Z",
        endedAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepStrictEqual(
        scope
          .map((row): Array<string | number | null> => [row.threadId, row.projectId, row.turnCount])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["thread-1", "project-1", 1],
          ["thread-2", "project-2", 1],
          ["thread-2", "project-2", 1],
          [null, null, 1],
        ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      );
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("UsageFactRepository scope titles", (it) => {
  it.effect("reads titles and deletion state against the real projection schema", () =>
    Effect.gen(function* () {
      yield* migrate;
      yield* insertProject("project-live", "  Live project ");
      yield* insertProject("project-gone", "Removed", true);
      yield* insertThread("thread-live", "project-live", "Live thread");
      yield* insertThread("thread-gone", "project-gone", "Deleted thread", true);
      yield* insertThread("thread-blank", "project-live", "   ");
      const repository = yield* UsageFactRepository;

      assert.deepStrictEqual(yield* repository.readScopeTitles({ threadIds: [], projectIds: [] }), {
        threads: [],
        projects: [],
      });
      const titles = yield* repository.readScopeTitles({
        threadIds: ["thread-live", "thread-gone", "thread-blank", "thread-missing"],
        projectIds: ["project-live", "project-gone", "project-missing"],
      });
      assert.deepStrictEqual(titles.projects, [
        { id: "project-live", title: "Live project", deleted: false },
        { id: "project-gone", title: "Removed", deleted: true },
        { id: "project-missing", title: null, deleted: true, projectId: null },
      ]);
      assert.deepStrictEqual(titles.threads, [
        { id: "thread-live", title: "Live thread", deleted: false, projectId: "project-live" },
        { id: "thread-gone", title: "Deleted thread", deleted: true, projectId: "project-gone" },
        { id: "thread-blank", title: null, deleted: false, projectId: "project-live" },
        { id: "thread-missing", title: null, deleted: true, projectId: null },
      ]);
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );
});

it.layer(SqliteClient.layerMemory())("UsageFactRepository at scale", (it) => {
  it.effect(
    "aggregates a deterministic 100,000-fact 90-day fixture into bounded rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrate;
        yield* sql`
        WITH RECURSIVE
          thousands(value) AS (
            SELECT 0
            UNION ALL
            SELECT value + 1 FROM thousands WHERE value < 999
          ),
          hundreds(value) AS (
            SELECT 0
            UNION ALL
            SELECT value + 1 FROM hundreds WHERE value < 99
          ),
          facts(value) AS (
            SELECT thousands.value * 100 + hundreds.value
            FROM thousands CROSS JOIN hundreds
          )
        INSERT INTO projection_turn_usage_facts (
          turn_id,
          thread_id,
          project_id,
          provider_name,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          total_tokens,
          provider_cost_usd,
          token_provenance,
          cost_provenance,
          completed_at,
          source_event_id
        )
        SELECT
          printf('benchmark-turn-%06d', value),
          printf('benchmark-thread-%04d', value % 5000),
          printf('benchmark-project-%02d', (value % 5000) % 40),
          CASE value % 5
            WHEN 0 THEN 'codex'
            WHEN 1 THEN 'claudeAgent'
            WHEN 2 THEN 'cursor'
            WHEN 3 THEN 'opencode'
            ELSE 'grok'
          END,
          'benchmark-model',
          100,
          20,
          50,
          120,
          CASE WHEN value % 5 < 2 THEN 0.01 ELSE NULL END,
          'provider-reported',
          CASE WHEN value % 5 < 2 THEN 'provider-reported' ELSE 'unreported' END,
          strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            '2026-08-15T00:00:00.000Z',
            '-' || (value % 2160) || ' hours',
            '-' || (value % 60) || ' minutes'
          ),
          printf('benchmark-event-%06d', value)
        FROM facts
      `;
        yield* sql`
          UPDATE projection_usage_metadata
          SET coverage_started_at = '2026-05-16T00:00:00.000Z',
              fact_cutover_at = '2026-05-16T00:00:00.000Z'
          WHERE singleton_id = 1
        `;

        const repository = yield* UsageFactRepository;
        const buckets = Array.from({ length: 92 }, (_, index) =>
          day(
            new Date(Date.parse("2026-05-16T00:00:00.000Z") + index * 86_400_000)
              .toISOString()
              .slice(0, 10),
          ),
        );
        const rows = yield* repository.summarizeBuckets({ buckets });
        const count = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_turn_usage_facts
        `;

        assert.deepStrictEqual(count, [{ count: 100_000 }]);
        // Bounded by buckets x providers x pricing partitions, not by facts.
        assert.isAtMost(rows.length, 92 * 5);
        assert.equal(
          rows.reduce((total, row) => total + row.turnCount, 0),
          100_000,
        );

        const scope = yield* repository.summarizeByScope({
          startedAt: buckets[0]!.startAt,
          endedAt: buckets[91]!.endAt,
        });
        assert.equal(scope.length, 5_000);
        assert.equal(
          scope.reduce((total, row) => total + row.turnCount, 0),
          100_000,
        );
        assert.equal(new Set(scope.map((row) => row.projectId)).size, 40);

        const statements = makeUsageBucketStatements(sql, { buckets }, "2026-06-01T00:00:00.000Z");
        const factPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN ${statements.facts}
        `;
        const factDetails = factPlan.map((step) => step.detail);
        const scanBuckets = factDetails.findIndex((detail) => /^SCAN b\b/.test(detail));
        const searchFacts = factDetails.findIndex((detail) =>
          detail.startsWith(
            "SEARCH f USING INDEX projection_turn_usage_facts_completed_idx (completed_at>? AND completed_at<?)",
          ),
        );
        assert.isAtLeast(scanBuckets, 0, factDetails.join("\n"));
        assert.isAbove(searchFacts, scanBuckets, factDetails.join("\n"));

        const legacyPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN ${statements.legacy!}
        `;
        const legacyDetails = legacyPlan.map((step) => step.detail);
        const scanLegacyBuckets = legacyDetails.findIndex((detail) => /^SCAN b\b/.test(detail));
        const searchEvents = legacyDetails.findIndex((detail) =>
          /^SEARCH e USING (COVERING )?INDEX idx_orch_events_type_occurred_at \(event_type=\? AND occurred_at>\? AND occurred_at<\?\)/.test(
            detail,
          ),
        );
        assert.isAtLeast(scanLegacyBuckets, 0, legacyDetails.join("\n"));
        assert.isAbove(searchEvents, scanLegacyBuckets, legacyDetails.join("\n"));
      }).pipe(Effect.provide(UsageFactRepositoryLive)),
    30_000,
  );
});
