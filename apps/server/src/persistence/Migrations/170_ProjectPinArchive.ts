import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<{ name: string }>(
    "SELECT name FROM pragma_table_info('projection_projects')",
  );
  if (!columns.length) return;
  if (!columns.some((column) => column.name === "pinned"))
    yield* sql.unsafe(
      "ALTER TABLE projection_projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    );
  if (!columns.some((column) => column.name === "archived"))
    yield* sql.unsafe(
      "ALTER TABLE projection_projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    );
});
