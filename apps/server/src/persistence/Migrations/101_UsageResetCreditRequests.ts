import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_reset_credit_requests (provider_instance_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT, PRIMARY KEY (provider_instance_id, idempotency_key))`;
  yield* sql`CREATE UNIQUE INDEX usage_reset_credit_pending ON usage_reset_credit_requests (provider_instance_id) WHERE result_json IS NULL`;
});
