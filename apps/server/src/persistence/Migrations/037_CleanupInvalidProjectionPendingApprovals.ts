import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
	    DELETE FROM projection_pending_approvals
	    WHERE status = 'pending'
	      AND NOT EXISTS (
	      SELECT 1
	      FROM projection_thread_activities AS activity
	      WHERE activity.kind = 'approval.requested'
        AND json_extract(activity.payload_json, '$.requestId')
          = projection_pending_approvals.request_id
    )
  `;
});
