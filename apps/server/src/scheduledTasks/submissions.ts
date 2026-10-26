import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Source-turn outcomes do not describe a child continuation that has not been accepted yet. */
export const scheduledRunLeafSubmissions = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{ submission_id: string; turn_id: string | null }>`SELECT s.submission_id,s.turn_id
    FROM scheduled_run_submissions s WHERE s.run_id=${runId} AND NOT EXISTS (
      SELECT 1 FROM scheduled_run_submissions child WHERE child.run_id=s.run_id
      AND child.parent_submission_id=s.submission_id AND child.recovery_decision='continue'
    ) ORDER BY s.rowid`;

/** Missing delivery evidence is not proof that a previously started submission was never sent. */
export const scheduledRunHasSettledLeaves = (sql: SqlClient.SqlClient, runId: string) =>
  Effect.gen(function* () {
    const leaves = yield* scheduledRunLeafSubmissions(sql, runId);
    if (!leaves.length) return false;
    for (const leaf of leaves) {
      const proof =
        yield* sql`SELECT 1 FROM turn_submissions WHERE submission_id=${leaf.submission_id} AND disposition IN('canceled','cleared','rejected')
      UNION ALL SELECT 1 FROM provider_turn_deliveries WHERE command_id=${leaf.submission_id} AND state='abandoned' AND certainty='not_sent'
      UNION ALL SELECT 1 FROM projection_turns WHERE turn_id=${leaf.turn_id} AND thread_id IN(SELECT thread_id FROM scheduled_task_runs WHERE id=${runId}) AND processing_quiesced_at IS NOT NULL`;
      if (!proof.length) return false;
    }
    return true;
  });
