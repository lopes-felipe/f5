import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_threads'
  `;
  if (tables.length === 0) return;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("pinned_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pinned_at TEXT`;
  }
  if (!names.has("pin_order_key")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pin_order_key INTEGER`;
  }
  if (!names.has("snoozed_until")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snoozed_until TEXT`;
  }
  if (!names.has("snoozed_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN snoozed_at TEXT`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_pin_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO projection_thread_pin_state (singleton_id, revision)
    VALUES (1, 0)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_pin_order_idx
    ON projection_threads(pin_order_key)
    WHERE pin_order_key IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_threads_snoozed_until_idx
    ON projection_threads(snoozed_until)
    WHERE snoozed_until IS NOT NULL
  `;
});
