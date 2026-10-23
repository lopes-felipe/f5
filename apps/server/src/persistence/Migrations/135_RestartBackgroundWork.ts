import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('restart_turn_markers')`;
  if (!columns.length || columns.some((column) => column.name === "interrupted_background_work"))
    return;
  yield* sql`ALTER TABLE restart_turn_markers ADD COLUMN interrupted_background_work INTEGER NOT NULL DEFAULT 0 CHECK(typeof(interrupted_background_work) = 'integer' AND interrupted_background_work BETWEEN 0 AND 201)`;
});
