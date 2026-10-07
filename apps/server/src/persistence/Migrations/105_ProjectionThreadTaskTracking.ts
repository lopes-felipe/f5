import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Bounded native Task tool correlation state, persisted with the task snapshot. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const existing = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('projection_threads')
    WHERE name = 'tasks_tracking_json'
  `;

  if (existing.length > 0) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN tasks_tracking_json TEXT
  `;
});
