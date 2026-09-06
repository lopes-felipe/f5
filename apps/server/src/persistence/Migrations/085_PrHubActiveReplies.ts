import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS pr_hub_operations_active_reply
    ON pr_hub_operations(provider_kind, host, viewer_id, repo, number, json_extract(payload_json, '$.threadId'))
    WHERE kind = 'reply' AND status IN ('prepared', 'creating', 'outcome_unknown')`;
});
