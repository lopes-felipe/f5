import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name IN ('tasks_turn_id', 'tasks_updated_at')
  `;

  const existingColumns = new Set(existing.map((row) => row.name));

  if (!existingColumns.has("tasks_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tasks_turn_id TEXT
    `;
  }

  if (!existingColumns.has("tasks_updated_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN tasks_updated_at TEXT
    `;
  }
});
