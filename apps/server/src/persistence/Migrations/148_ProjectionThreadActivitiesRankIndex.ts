import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Covers the retained-activities rank (per thread, newest first), so the
 * window function reads keys from the index and payloads only for kept rows.
 * The build is a one-time scan, so its duration is logged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = performance.now();
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_rank
    ON projection_thread_activities(thread_id, sequence DESC, created_at DESC, activity_id DESC)`;
  yield* Effect.logInfo("built projection_thread_activities rank index", {
    durationMs: Math.round(performance.now() - startedAt),
  });
});
