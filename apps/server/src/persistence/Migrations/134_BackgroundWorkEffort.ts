import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_thread_background_work')`;
  if (!columns.length || columns.some((column) => column.name === "effort")) return;
  yield* sql`ALTER TABLE projection_thread_background_work ADD COLUMN effort TEXT CHECK(effort IS NULL OR length(effort) <= 64)`;
});
