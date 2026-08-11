import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LATEST_MIGRATION, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("061_TurnDurabilitySchemaRepair", (it) => {
  it.effect("repairs databases that recorded migration 60 without turn durability schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
      yield* sql`
        CREATE TABLE projection_turns (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          state TEXT NOT NULL,
          requested_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (thread_id, state, requested_at)
        VALUES ('thread-1', 'pending', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (60, 'NextTurnQueueSchemaRepair')
      `;

      yield* runMigrations;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_turns')
      `;
      assert(columns.some((column) => column.name === "processing_quiesced_at"));

      const turns = yield* sql<{
        readonly threadId: string;
        readonly processingQuiescedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          processing_quiesced_at AS "processingQuiescedAt"
        FROM projection_turns
      `;
      assert.deepStrictEqual(turns, [{ threadId: "thread-1", processingQuiescedAt: null }]);

      const attachmentTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('attachments', 'attachment_owners', 'attachment_cleanup_jobs')
        ORDER BY name
      `;
      assert.deepStrictEqual(attachmentTables, [
        { name: "attachment_cleanup_jobs" },
        { name: "attachment_owners" },
        { name: "attachments" },
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
