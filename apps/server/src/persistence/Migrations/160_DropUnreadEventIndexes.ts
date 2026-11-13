import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drops the event log's indexes on `command_id` and `correlation_id`.
 *
 * No query reads either: commands are looked up through
 * `orchestration_command_receipts`, events are read by stream, sequence or
 * type, and nothing filters on a correlation ID. Each held one entry per event
 * (about 140 MB apiece on a 1.5 million event log) and cost every append an
 * index write. The freed pages are reused by later writes or returned to disk
 * by storage maintenance (see `databaseSpace.ts`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
});
