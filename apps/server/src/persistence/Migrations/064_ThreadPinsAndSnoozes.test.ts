import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0064 from "./064_ThreadPinsAndSnoozes.ts";

it.layer(SqliteClient.layerMemory())("064_ThreadPinsAndSnoozes", (it) => {
  it.effect("adds thread pin and snooze state idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL
        )
      `;

      yield* Migration0064;
      yield* Migration0064;

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        SELECT name, "notnull"
        FROM pragma_table_info('projection_threads')
        WHERE name IN ('pinned_at', 'pin_order_key', 'snoozed_until', 'snoozed_at')
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(columns, [
        { name: "pin_order_key", notnull: 0 },
        { name: "pinned_at", notnull: 0 },
        { name: "snoozed_at", notnull: 0 },
        { name: "snoozed_until", notnull: 0 },
      ]);

      const state = yield* sql<{
        readonly singleton_id: number;
        readonly revision: number;
      }>`SELECT singleton_id, revision FROM projection_thread_pin_state`;
      assert.deepStrictEqual(state, [{ singleton_id: 1, revision: 0 }]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'projection_threads_pin_order_idx',
            'projection_threads_snoozed_until_idx'
          )
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(indexes, [
        { name: "projection_threads_pin_order_idx" },
        { name: "projection_threads_snoozed_until_idx" },
      ]);
    }),
  );
});
