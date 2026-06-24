import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('pr_hub_viewer_state')
    WHERE name = 'ignored_at'
  `;

  if (columns.length === 0) {
    yield* sql`
      ALTER TABLE pr_hub_viewer_state
      ADD COLUMN ignored_at TEXT
    `;
  }
});
