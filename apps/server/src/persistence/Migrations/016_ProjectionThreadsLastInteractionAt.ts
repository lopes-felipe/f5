import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'last_interaction_at'
  `;

  if (existingColumns.length === 0) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN last_interaction_at TEXT NOT NULL DEFAULT ''
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET last_interaction_at = updated_at
    WHERE last_interaction_at = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_last_interaction
    ON projection_threads(project_id, last_interaction_at)
  `;
});
