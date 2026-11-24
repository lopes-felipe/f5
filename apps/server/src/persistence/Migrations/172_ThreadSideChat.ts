import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<{ name: string }>(
    "SELECT name FROM pragma_table_info('projection_threads')",
  );
  if (columns.length && !columns.some((column) => column.name === "side_chat_of"))
    yield* sql.unsafe("ALTER TABLE projection_threads ADD COLUMN side_chat_of TEXT");
});
