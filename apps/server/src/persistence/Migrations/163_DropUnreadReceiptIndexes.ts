import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drops the command receipt indexes on `(aggregate_kind, aggregate_id)` and
 * `result_sequence`.
 *
 * Every reader finds a receipt by `command_id`, the primary key: the engine's
 * duplicate check, the queue's accepted check, workspace transition proofs,
 * pull request watch stops, thread purge and event compaction. Nothing lists
 * receipts by aggregate or by sequence. Each command writes one receipt, so
 * each index cost one write per command (about 125 MB together on 1.9 million
 * receipts). The freed pages are reused by later writes or returned to disk by
 * storage maintenance (see `databaseSpace.ts`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});
