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
      AND t.turn_id IS NOT NULL
      AND julianday(t.completed_at) <= julianday(upstream_port_reviews.updated_at)
    ORDER BY julianday(t.requested_at) DESC, t.row_id DESC LIMIT 1
  )
  WHERE review_workflow_id IS NULL AND review_input_json IS NULL
    AND apply_command_json IS NULL
    AND (
      (status = 'error' AND error_stage = 'review-setup' AND detail IN (
        'Port turn interrupted; finish the port or Retry review after opening a PR',
        'Port turn error; finish the port or Retry review after opening a PR'
      ))
      OR (status = 'skipped' AND detail IN (
        'Port ended with blocked', 'Port ended without a pull request for any topic'
      ))
    )`;
  // Grouped outcomes share one diagnostic with all-equivalent/not-applicable stops.
  // Only the blocked receipt from the stopped turn is evidence for automatic recovery.
  yield* sql`UPDATE upstream_port_reviews SET resume_after_turn_id = NULL
    WHERE detail = 'Port ended without a pull request for any topic'
      AND resume_after_turn_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM upstream_port_topic_outcomes o
        WHERE o.project_id = upstream_port_reviews.project_id
          AND o.thread_id = upstream_port_reviews.port_thread_id
          AND o.turn_id = upstream_port_reviews.resume_after_turn_id AND o.kind = 'blocked'
      )`;
  yield* sql`CREATE INDEX upstream_port_reviews_recoverable
    ON upstream_port_reviews(port_thread_id)
    WHERE status IN ('error','skipped') AND resume_after_turn_id IS NOT NULL`;
});
