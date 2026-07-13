import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Records the first actual dispatch attempt separately from enqueue time.
 * The timestamp must survive retries so a durable command ID always projects
 * the same user-message chronology after a server restart.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info('next_turn_queue')
  `;

  if (!columns.some((column) => column.name === "dispatch_started_at")) {
    yield* sql`
      ALTER TABLE next_turn_queue
      ADD COLUMN dispatch_started_at TEXT
    `;
  }
});
