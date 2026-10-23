import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_app_instances (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(attachment_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL, reference_json TEXT NOT NULL CHECK(json_valid(reference_json) AND length(CAST(reference_json AS BLOB))<=65536),
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_app_instances_thread ON mcp_app_instances(thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_app_model_context (
    attachment_id TEXT NOT NULL REFERENCES mcp_app_instances(attachment_id) ON DELETE CASCADE,
    server TEXT NOT NULL, resource_uri TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB))<=32768),
    message_bytes INTEGER NOT NULL CHECK(message_bytes BETWEEN 1 AND 262144),
    updated_at TEXT NOT NULL, PRIMARY KEY(thread_id,server,resource_uri)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_app_model_context_thread ON mcp_app_model_context(thread_id,updated_at)`;
});
