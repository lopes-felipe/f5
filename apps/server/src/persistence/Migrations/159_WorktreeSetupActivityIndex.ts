import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Indexes the few worktree setup activities (one per thread that ran a setup).
 *
 * Every server start reads them to settle setups a restart interrupted. With no
 * index on `kind` that read scanned the whole activity table, payloads
 * included, on the connection the server shares with everything else: about
 * seven seconds for 470,000 activities. The index is partial, so it holds only
 * these rows, and the reading query spells the kind as the same literal.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_worktree_setup
    ON projection_thread_activities(thread_id)
    WHERE kind = 'worktree-setup'
  `;
});
