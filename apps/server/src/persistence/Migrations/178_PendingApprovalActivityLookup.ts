import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_approval_request
    ON projection_thread_activities(thread_id, json_extract(payload_json, '$.requestId'))
    WHERE kind = 'approval.requested' AND json_valid(payload_json)`;
});
