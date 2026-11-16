import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep startup recovery proportional to unfinished moves, not the size of old file manifests.
  yield* sql`CREATE INDEX workspace_transitions_move_recovery ON workspace_transitions(operation_id)
    WHERE json_extract(record_json,'$.intent')='move_to_new_worktree'
    AND (phase IN ('reserved','stopping','applying','applied','needs_recovery')
      OR json_extract(record_json,'$.moveData.snapshotRef') IS NOT NULL)`;
});
