import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Hardened in place for fresh/replayed DBs; 047 repairs DBs that already applied 014.
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'projection_thread_proposed_plans'
  `;

  if (tables.length === 0) {
    yield* sql`
      CREATE TABLE projection_thread_proposed_plans (
        plan_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        plan_markdown TEXT NOT NULL,
        implemented_at TEXT,
        implementation_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_proposed_plans')
  `;
  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("implemented_at")) {
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implemented_at TEXT
    `;
  }

  if (!existingColumns.has("implementation_thread_id")) {
    yield* sql`
      ALTER TABLE projection_thread_proposed_plans
      ADD COLUMN implementation_thread_id TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_created
    ON projection_thread_proposed_plans(thread_id, created_at)
  `;
});
