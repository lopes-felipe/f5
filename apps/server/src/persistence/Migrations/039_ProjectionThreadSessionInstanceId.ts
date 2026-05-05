import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_sessions')
    WHERE name = 'provider_instance_id'
  `;

  if (columns.length === 0) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN provider_instance_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = provider_name
    WHERE provider_instance_id IS NULL
      AND provider_name IS NOT NULL
      AND length(trim(provider_name)) > 0
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
    ON projection_thread_sessions(provider_instance_id)
  `;
});
