import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LATEST_MIGRATION, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("062_LegacyTurnQuiescenceBackfill", (it) => {
  it.effect("quiesces only terminal turns that predate the schema repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          processing_quiesced_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at,
          processing_quiesced_at
        ) VALUES
          ('thread-1', 'legacy-completed', 'completed', '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', NULL),
          ('thread-1', 'legacy-error', 'error', '2026-01-02T00:00:00.000Z',
           '2026-01-02T00:01:00.000Z', NULL, NULL),
          ('thread-1', 'post-repair', 'completed', '2026-02-01T00:00:00.000Z',
           '2026-02-01T00:01:00.000Z', '2026-02-01T00:02:00.000Z', NULL),
          ('thread-1', 'still-running', 'running', '2026-01-03T00:00:00.000Z',
           '2026-01-03T00:01:00.000Z', NULL, NULL),
          ('thread-1', 'already-quiesced', 'completed', '2026-01-04T00:00:00.000Z',
           '2026-01-04T00:01:00.000Z', '2026-01-04T00:02:00.000Z',
           '2026-01-04T00:03:00.000Z')
      `;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (61, '2026-01-15 00:00:00', 'TurnDurabilitySchemaRepair')
      `;

      yield* runMigrations;

      const turns = yield* sql<{
        readonly turnId: string;
        readonly processingQuiescedAt: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          processing_quiesced_at AS "processingQuiescedAt"
        FROM projection_turns
        ORDER BY row_id
      `;
      assert.deepStrictEqual(turns, [
        {
          turnId: "legacy-completed",
          processingQuiescedAt: "2026-01-01T00:02:00.000Z",
        },
        { turnId: "legacy-error", processingQuiescedAt: "2026-01-02T00:01:00.000Z" },
        { turnId: "post-repair", processingQuiescedAt: null },
        { turnId: "still-running", processingQuiescedAt: null },
        {
          turnId: "already-quiesced",
          processingQuiescedAt: "2026-01-04T00:03:00.000Z",
        },
      ]);

      const latestMigration = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;
      assert.deepStrictEqual(latestMigration, [LATEST_MIGRATION]);
    }),
  );
});
