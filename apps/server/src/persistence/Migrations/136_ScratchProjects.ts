import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Only the scratch project's threads carry a scratch folder. The decider keeps a profile to
// one live scratch project, so no index is needed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Repair paths can run on databases that never created the projection tables.
  const columnsOf = (table: string) =>
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
      if (tables.length === 0) return null;
      const rows = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
      return new Set(rows.map((row) => row.name));
    });
  const projectColumns = yield* columnsOf("projection_projects");
  if (projectColumns && !projectColumns.has("kind"))
    yield* sql`ALTER TABLE projection_projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK(kind IN ('standard', 'scratch'))`;
  const threadColumns = yield* columnsOf("projection_threads");
  if (threadColumns && !threadColumns.has("scratch_path"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN scratch_path TEXT`;
});
