import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Lets the per-thread rewind draft read (`getRewindDrafts`, run on every
 * thread open) find unresolved drafts without scanning the whole table.
 * Completed operations are never deleted, so the table only grows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_rewind_operations_unresolved_drafts
    ON rewind_operations(thread_id, created_at)
    WHERE draft_resolved_at IS NULL
  `;
});
