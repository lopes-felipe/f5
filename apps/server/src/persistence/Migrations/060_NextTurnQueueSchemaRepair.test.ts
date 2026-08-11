import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LATEST_MIGRATION, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0054 from "./054_NextTurnQueue.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("060_NextTurnQueueSchemaRepair", (it) => {
  it.effect("repairs databases that recorded migration 59 with the legacy queue schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO projection_threads (thread_id) VALUES ('thread-1')`;
      yield* Migration0054;
      yield* sql`
        INSERT INTO next_turn_queue (
          item_id, thread_id, command_id, position, status, allow_after_error,
          command_json, created_at, updated_at
        ) VALUES (
          'legacy-item', 'thread-1', 'legacy-command', 0, 'queued', 0,
          ${JSON.stringify({ message: { attachments: [{ id: "attachment-1" }] } })},
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
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
        VALUES (59, 'QueueReviewHardening')
      `;

      yield* runMigrations;

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('next_turn_queue')
      `;
      assert(columns.some((column) => column.name === "submission_id"));
      assert(columns.some((column) => column.name === "lease_owner"));

      const orphaned = yield* sql<{ readonly attachmentId: string }>`
        SELECT attachment_id AS "attachmentId"
        FROM next_turn_queue_orphaned_attachments
      `;
      assert.deepStrictEqual(orphaned, [{ attachmentId: "attachment-1" }]);

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
