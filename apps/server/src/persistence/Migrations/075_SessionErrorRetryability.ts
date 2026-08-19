import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_sessions'
  `;
  if (tables.length === 0) return;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_sessions')
  `;
  if (!columns.some((column) => column.name === "last_error_retryability")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN last_error_retryability TEXT
    `;
  }
});
