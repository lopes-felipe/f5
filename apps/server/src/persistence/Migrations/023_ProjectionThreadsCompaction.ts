import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'compaction_json'
  `;

  if (existing.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN compaction_json TEXT
  `;
});
