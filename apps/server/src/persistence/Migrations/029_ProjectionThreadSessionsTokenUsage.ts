import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_sessions')
    WHERE name IN ('estimated_context_tokens', 'token_usage_source')
  `;

  const existingColumns = new Set(existing.map((row) => row.name));

  if (!existingColumns.has("estimated_context_tokens")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN estimated_context_tokens INTEGER
    `;
  }

  if (!existingColumns.has("token_usage_source")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN token_usage_source TEXT
    `;
  }
});
