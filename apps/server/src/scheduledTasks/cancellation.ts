import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Fence first, then cancel only work proven not to have crossed a provider handoff.
 * The caller owns the SQL transaction. A sending/unknown delivery retains ownership.
 */
export const fenceScheduledRun = (runId: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_task_runs SET canceled=1 WHERE id=${runId}`;
    yield* sql`UPDATE next_turn_queue SET deleted_at=${at},lease_owner=NULL,lease_expires_at=NULL,updated_at=${at}
    WHERE submission_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${runId}) AND deleted_at IS NULL`;
    yield* sql`UPDATE turn_submissions SET disposition='canceled',reason_code='scheduled_run_canceled',settled_at=${at}
    WHERE submission_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${runId}) AND disposition IN('pending','queued')`;
    yield* sql`UPDATE provider_turn_deliveries SET state='abandoned',certainty='not_sent',error_code='scheduled_run_canceled',error_detail='Scheduled execution was canceled before delivery.',updated_at=${at},reservation_released_at=${at}
    WHERE command_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${runId}) AND (state='pending' OR (state='rejected' AND certainty='not_sent'))`;
    yield* sql`DELETE FROM projection_turns WHERE turn_id IS NULL AND pending_message_id IN(SELECT message_id FROM scheduled_run_submissions WHERE run_id=${runId})`;
    const uncertain = yield* sql`SELECT delivery_id FROM provider_turn_deliveries
    WHERE command_id IN(SELECT submission_id FROM scheduled_run_submissions WHERE run_id=${runId})
    AND (state IN('sending','ambiguous') OR (state='rejected' AND certainty IS NOT 'not_sent') OR (state='accepted' AND reservation_released_at IS NULL))`;
    const activeTurns =
      yield* sql`SELECT t.turn_id FROM projection_turns t JOIN scheduled_run_submissions s ON s.thread_id=t.thread_id AND s.turn_id=t.turn_id
      WHERE s.run_id=${runId} AND t.state='running' AND t.processing_quiesced_at IS NULL`;
    return uncertain.length === 0 && activeTurns.length === 0;
  });
