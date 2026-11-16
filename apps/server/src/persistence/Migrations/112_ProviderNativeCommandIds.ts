import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Native command ids minted before the first send, so a retried F5 delivery
 * replays the same provider command instead of submitting a second one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE provider_native_command_ids (
    f5_command_id TEXT PRIMARY KEY,
    provider_instance_id TEXT NOT NULL,
    native_command_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX provider_native_command_ids_instance
    ON provider_native_command_ids(provider_instance_id, created_at)`;
});
