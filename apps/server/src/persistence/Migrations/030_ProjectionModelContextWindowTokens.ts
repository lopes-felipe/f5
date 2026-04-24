import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'model_context_window_tokens'
  `;

  if (threadColumns.length === 0) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model_context_window_tokens INTEGER
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_thread_sessions')
    WHERE name = 'model_context_window_tokens'
  `;

  if (sessionColumns.length === 0) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN model_context_window_tokens INTEGER
    `;
  }
});
