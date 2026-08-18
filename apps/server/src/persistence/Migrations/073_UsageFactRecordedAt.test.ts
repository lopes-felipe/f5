import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0068 from "./068_UsageFacts.ts";
import Migration0073 from "./073_UsageFactRecordedAt.ts";

it.layer(SqliteClient.layerMemory())("073_UsageFactRecordedAt", (it) => {
  it.effect("backfills the ingestion clock and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY)`;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        )
      `;
      yield* Migration0068;
      yield* sql`
        UPDATE projection_usage_metadata
        SET coverage_started_at = '2026-08-10T00:00:00.000Z'
        WHERE singleton_id = 1
      `;
      yield* sql`
        INSERT INTO projection_turn_usage_facts (
          turn_id,
          thread_id,
          project_id,
          provider_name,
          token_provenance,
          cost_provenance,
          completed_at,
          source_event_id
        ) VALUES (
          'turn-before-recorded-at',
          'thread-1',
          'project-1',
          'codex',
          'unreported',
          'unreported',
          '2026-08-09T23:59:59.000Z',
          'event-1'
        )
      `;

      yield* Migration0073;
      yield* Migration0073;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turn_usage_facts')
      `;
      const rows = yield* sql<{ readonly recordedAt: string }>`
        SELECT recorded_at AS "recordedAt"
        FROM projection_turn_usage_facts
        WHERE turn_id = 'turn-before-recorded-at'
      `;
      const metadata = yield* sql<{ readonly factCutoverAt: string }>`
        SELECT fact_cutover_at AS "factCutoverAt"
        FROM projection_usage_metadata
        WHERE singleton_id = 1
      `;
      assert.equal(columns.filter((column) => column.name === "recorded_at").length, 1);
      assert.deepStrictEqual(rows, [{ recordedAt: "2026-08-10T00:00:00.000Z" }]);
      assert.deepStrictEqual(metadata, [{ factCutoverAt: "2026-08-10T00:00:00.000Z" }]);
    }),
  );
});
