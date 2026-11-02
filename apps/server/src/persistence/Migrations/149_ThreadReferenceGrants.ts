import RepairProjectionCoreSchema from "./048_ProjectionCoreSchemaRepair.ts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A thread reference a person sent explicitly lets that thread's agent read the referenced
 * thread. Only explicit human provenance writes a grant; a reference stops authorizing once its
 * message is gone (rewinds delete message rows, and reads join through them).
 */
export default Effect.gen(function* () {
  yield* RepairProjectionCoreSchema;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_reference_grants (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    target_thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, target_thread_id, message_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_reference_grants_lookup
    ON thread_reference_grants(thread_id, target_thread_id)`;
});
