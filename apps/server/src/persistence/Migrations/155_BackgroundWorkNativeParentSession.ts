import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_background_work')`;
  if (!columns.length || columns.some((column) => column.name === "native_parent_session_id"))
    return;
  yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN native_parent_session_id TEXT CHECK(native_parent_session_id IS NULL OR length(native_parent_session_id) <= 128)`;
});
