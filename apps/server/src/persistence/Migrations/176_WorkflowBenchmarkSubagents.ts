import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_benchmark_subagent_activity
    ON projection_thread_activities(thread_id, turn_id)
    WHERE kind IN ('subagent.activity','task.started','task.progress','task.completed')
  `;
});
