import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_projects')
    WHERE name = 'default_model_selection_json'
  `;

  if (columns.length === 0) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_model_selection_json TEXT
    `;
  }
});
