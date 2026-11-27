import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** F5 MCP hub: tool pins, the tool call log, and per-conversation server toggles. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per server definition (identity) and tool. `accepted_*` is what the user
  // accepted (or the first listing); `observed_*` is what the server reports now.
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_tool_pins (
    identity TEXT NOT NULL,
    server_key TEXT NOT NULL,
    server_name TEXT NOT NULL,
    identity_label TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    accepted_digest TEXT NOT NULL,
    accepted_json TEXT NOT NULL CHECK(length(CAST(accepted_json AS BLOB))<=131072),
    observed_digest TEXT NOT NULL,
    observed_json TEXT NOT NULL CHECK(length(CAST(observed_json AS BLOB))<=131072),
    is_new INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    accepted_at TEXT,
    PRIMARY KEY(identity, tool_name)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_tool_pins_server ON mcp_tool_pins(server_key)`;
  // Arguments and results are never stored.
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,
    server_key TEXT NOT NULL,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    approval TEXT NOT NULL,
    error_summary TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_tool_calls_created ON mcp_tool_calls(created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS mcp_tool_calls_server ON mcp_tool_calls(server_key, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS mcp_thread_server_overrides (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    server_key TEXT NOT NULL,
    server_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, server_key)
  )`;
});
