import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Worktree setup reads its own activities at startup. Without an index on
 * `kind` that read scans every activity payload. A partial index holds only
 * the worktree-setup rows; the query must spell the kind as a literal for
 * SQLite to use it. The build is a one-time scan, so its duration is logged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = performance.now();
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_worktree_setup
    ON projection_thread_activities(thread_id)
    WHERE kind = 'worktree-setup'`;
  yield* Effect.logInfo("built projection_thread_activities worktree-setup index", {
    durationMs: Math.round(performance.now() - startedAt),
  });
});
