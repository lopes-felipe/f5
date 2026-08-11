import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { LATEST_MIGRATION, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("059_QueueReviewHardening", (it) => {
  it.effect("repairs databases that recorded migration 58 without the delivery table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (58, 'TurnDeliveryDurability')
      `;

      yield* runMigrations;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_turn_deliveries'
      `;
      assert.deepStrictEqual(tables, [{ name: "provider_turn_deliveries" }]);

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('provider_turn_deliveries')
      `;
      assert(columns.some((column) => column.name === "outcome_projected_at"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_provider_turn_deliveries_%'
        ORDER BY name
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_provider_turn_deliveries_actionable" },
        { name: "idx_provider_turn_deliveries_thread" },
        { name: "idx_provider_turn_deliveries_unprojected" },
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
