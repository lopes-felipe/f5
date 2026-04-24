import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'archived_at'
  `;

  if (existingColumns.length === 0) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_last_interaction
    ON projection_threads(project_id, archived_at, last_interaction_at)
  `;
});
