import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'`;
  if (!tables.length) return;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (columns.some((column) => column.name === "title_state_json")) return;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
});
