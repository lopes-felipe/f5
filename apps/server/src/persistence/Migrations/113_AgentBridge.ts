import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * F5 Agent Bridge core: connected clients, idempotency receipts for every
 * bridge write, which client created which thread, and the workspace
 * revision that UI invalidations carry.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_bridge_clients (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'cimd', 'dcr')),
    name TEXT NOT NULL,
    label TEXT,
    scopes_json TEXT NOT NULL,
    project_ids_json TEXT NOT NULL,
    grant_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`;
  yield* sql`CREATE TABLE agent_bridge_requests (
    namespace TEXT NOT NULL,
    request_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    command_json TEXT,
    related_ids_json TEXT NOT NULL DEFAULT '{}',
    thread_id TEXT,
    submission_id TEXT,
    result_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, request_id)
  )`;
  yield* sql`CREATE INDEX agent_bridge_requests_submission
    ON agent_bridge_requests(namespace, submission_id) WHERE submission_id IS NOT NULL`;
  yield* sql`CREATE INDEX agent_bridge_requests_thread
    ON agent_bridge_requests(namespace, thread_id) WHERE thread_id IS NOT NULL`;
  yield* sql`CREATE INDEX agent_bridge_requests_status
    ON agent_bridge_requests(status, updated_at)`;
  yield* sql`CREATE TABLE agent_bridge_threads (
    thread_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_bridge_threads_client
    ON agent_bridge_threads(client_id, created_at)`;
  yield* sql`CREATE TABLE agent_bridge_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO agent_bridge_revision (id, revision) VALUES (1, 0)`;
});
