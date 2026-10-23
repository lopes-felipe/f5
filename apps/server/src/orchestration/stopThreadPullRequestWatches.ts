import type { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Run inside the command transaction: a crash before live subscribers run must not revive a watch. */
export function stopThreadPullRequestWatches(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  at: string,
) {
  return Effect.gen(function* () {
    yield* sql`INSERT INTO thread_pull_request_watch_stops(thread_id,generation) SELECT thread_id,1 FROM projection_threads WHERE thread_id=${threadId} ON CONFLICT(thread_id) DO UPDATE SET generation=generation+1`;
    yield* sql`DELETE FROM thread_pull_request_watches WHERE thread_id=${threadId}`;
    const canceled = yield* sql<{ submissionId: string }>`UPDATE next_turn_queue
      SET deleted_at=${at},updated_at=${at}
      WHERE thread_id=${threadId} AND schedule_reason='pull_request_watch'
        AND status!='dispatching' AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM orchestration_command_receipts r
          WHERE r.command_id=next_turn_queue.command_id AND r.status='accepted')
      RETURNING submission_id AS "submissionId"`;
    for (const item of canceled)
      yield* sql`UPDATE turn_submissions
      SET disposition='canceled',reason_code='watch_stopped',settled_at=${at}
      WHERE submission_id=${item.submissionId} AND disposition IN ('pending','queued')`;
    if (canceled.length)
      yield* sql`UPDATE next_turn_queue_state SET revision=revision+1,updated_at=${at} WHERE thread_id=${threadId}`;
  });
}
