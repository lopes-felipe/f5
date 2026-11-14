import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE upstream_port_reviews ADD COLUMN resume_after_turn_id TEXT`;
  // Only recover implementation stops. Review/setup/apply failures still need explicit retry.
  // Use the turn observed at the stop, not a continuation that may already have completed.
  yield* sql`UPDATE upstream_port_reviews SET resume_after_turn_id = (
    SELECT t.turn_id FROM projection_turns t
    WHERE t.thread_id = upstream_port_reviews.port_thread_id
      AND t.turn_id IS NOT NULL AND t.completed_at <= upstream_port_reviews.updated_at
    ORDER BY t.requested_at DESC, t.row_id DESC LIMIT 1
  )
  WHERE review_workflow_id IS NULL AND review_input_json IS NULL
    AND apply_command_json IS NULL
    AND (
      (status = 'error' AND error_stage = 'review-setup' AND detail IN (
        'Port turn interrupted; finish the port or Retry review after opening a PR',
        'Port turn error; finish the port or Retry review after opening a PR'
      ))
      OR (status = 'skipped' AND detail = 'Port ended with blocked')
    )`;
  yield* sql`CREATE INDEX upstream_port_reviews_recoverable
    ON upstream_port_reviews(port_thread_id)
    WHERE status IN ('error','skipped') AND resume_after_turn_id IS NOT NULL`;
});
