import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (tables.length === 0) return;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("default_env_mode")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN default_env_mode TEXT`;
  }
  if (!names.has("icon_json")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN icon_json TEXT`;
  }
});
