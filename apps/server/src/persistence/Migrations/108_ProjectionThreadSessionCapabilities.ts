import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Session capability snapshot (generation, discovery, supported actions) per thread. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Repair paths can run on databases that never created the projection tables.
  const existing = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_sessions')
  `;
  if (existing.length === 0 || existing.some((column) => column.name === "capabilities_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_thread_sessions
    ADD COLUMN capabilities_json TEXT
  `;
});
