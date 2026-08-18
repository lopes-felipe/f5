import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId, TurnId, type UsageTurnFact } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0001 from "../Migrations/001_OrchestrationEvents.ts";
import Migration0068 from "../Migrations/068_UsageFacts.ts";
import Migration0073 from "../Migrations/073_UsageFactRecordedAt.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import { UsageFactRepository } from "../Services/UsageFacts.ts";
import { UsageFactRepositoryLive } from "./UsageFacts.ts";

it.layer(SqliteClient.layerMemory())("UsageFactRepository", (it) => {
  it.effect("upserts facts idempotently and includes pre-coverage event-log costs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)`;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        )
      `;
      yield* Migration0001;
      yield* Migration0068;
      yield* Migration0073;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-10T00:00:00.000Z'
        WHERE singleton_id = 1
      `;

      const repository = yield* UsageFactRepository;
      const fact: UsageTurnFact = {
        turnId: TurnId.makeUnsafe("turn-current"),
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
        sourceEventId: EventId.makeUnsafe("event-current"),
      };
      yield* repository.record(fact);
      yield* repository.record(fact);

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          'legacy-cost-event',
          'thread',
          'thread-1',
          1,
          'thread.session-set',
          '2026-08-09T08:30:00.000Z',
          NULL,
          NULL,
          NULL,
          'provider',
          '{"session":{"providerName":"claudeAgent","turnCostUsd":0.75}}',
          '{}'
        )
      `;

      const rows = yield* repository.summarizeHourly({
        startedAt: "2026-08-08T00:00:00.000Z",
        endedAt: "2026-08-13T00:00:00.000Z",
      });

      assert.equal(rows.length, 2);
      assert.deepStrictEqual(
        rows.map((row) => ({
          provider: row.provider,
          turns: row.turnCount,
          tokens: row.totalTokens,
          cost: row.providerReportedCostUsd,
          historical: row.historicalCostTurnCount,
        })),
        [
          { provider: "codex", turns: 1, tokens: 100, cost: null, historical: 0 },
          { provider: "claudeAgent", turns: 1, tokens: 0, cost: 0.75, historical: 1 },
        ],
      );
    }).pipe(Effect.provide(UsageFactRepositoryLive)),
  );

  it.effect(
    "aggregates a deterministic 100,000-fact 90-day fixture into bounded hourly rows",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE IF NOT EXISTS projection_projects (project_id TEXT PRIMARY KEY)`;
        yield* sql`
        CREATE TABLE IF NOT EXISTS projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        )
      `;
        yield* Migration0001;
        yield* Migration0068;
        yield* Migration0073;
        yield* sql`DELETE FROM projection_turn_usage_facts`;
        yield* sql`DELETE FROM orchestration_events`;
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
          'benchmark-thread',
          'benchmark-project',
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
            '%Y-%m-%dT%H:00:00.000Z',
            '2026-08-15T00:00:00.000Z',
            '-' || (value % 2160) || ' hours'
          ),
          printf('benchmark-event-%06d', value)
        FROM facts
      `;
        yield* sql`
          UPDATE projection_usage_metadata
          SET coverage_started_at = '2026-05-17T00:00:00.000Z',
              fact_cutover_at = '2026-05-17T00:00:00.000Z'
          WHERE singleton_id = 1
        `;

        const repository = yield* UsageFactRepository;
        const rows = yield* repository.summarizeHourly({
          startedAt: "2026-05-17T00:00:00.000Z",
          endedAt: "2026-08-15T01:00:00.000Z",
        });
        const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_turn_usage_facts
      `;

        assert.deepStrictEqual(count, [{ count: 100_000 }]);
        assert.equal(rows.length, 2_160);
        assert.equal(
          rows.reduce((total, row) => total + row.turnCount, 0),
          100_000,
        );
      }).pipe(Effect.provide(UsageFactRepositoryLive)),
    15_000,
  );
});
