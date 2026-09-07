import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS pr_hub_operations_active_submission`;
  yield* sql`CREATE UNIQUE INDEX pr_hub_operations_active_submission
    ON pr_hub_operations(provider_kind, host, viewer_id, repo, number)
    WHERE kind = 'review' AND status NOT IN ('succeeded', 'failed_before_send', 'rejected', 'abandoned')`;
});
