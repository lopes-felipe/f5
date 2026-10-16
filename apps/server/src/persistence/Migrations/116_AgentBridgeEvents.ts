import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent Bridge MCP Events: webhook subscriptions with their delivery state and
 * two watermarks (orchestration event sequence and task workspace revision),
 * verified callback URLs, and short-lived delivery diagnostics. Webhook
 * secrets live in the server secret store; rows keep only references.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_bridge_event_subscriptions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    token_family_id TEXT NOT NULL,
    grant_generation INTEGER NOT NULL,
    name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    previous_secret_ref TEXT,
    previous_secret_until TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'delivery-failed')),
    event_watermark INTEGER NOT NULL,
    task_watermark INTEGER NOT NULL,
    backlog_pending INTEGER NOT NULL DEFAULT 0,
    pending_event_json TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    lease_until TEXT,
    last_error TEXT,
    last_delivered_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_bridge_event_subscriptions_client
    ON agent_bridge_event_subscriptions(client_id)`;
  yield* sql`CREATE INDEX agent_bridge_event_subscriptions_expiry
    ON agent_bridge_event_subscriptions(expires_at)`;
  yield* sql`CREATE TABLE agent_bridge_verified_callbacks (
    client_id TEXT NOT NULL,
    url TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (client_id, url)
  )`;
  yield* sql`CREATE INDEX agent_bridge_verified_callbacks_expiry
    ON agent_bridge_verified_callbacks(expires_at)`;
  yield* sql`CREATE TABLE agent_bridge_event_deliveries (
    event_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    name TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'skipped', 'gone')),
    attempts INTEGER NOT NULL,
    last_status INTEGER,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_bridge_event_deliveries_created
    ON agent_bridge_event_deliveries(created_at)`;
});
