import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<{ name: string }>(
    "SELECT name FROM pragma_table_info('projection_thread_sessions')",
  );
  if (columns.length && !columns.some((column) => column.name === "auto_compact_threshold"))
    yield* sql.unsafe(
      "ALTER TABLE projection_thread_sessions ADD COLUMN auto_compact_threshold INTEGER",
    );
});
