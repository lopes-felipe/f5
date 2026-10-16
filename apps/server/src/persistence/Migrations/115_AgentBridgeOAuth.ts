import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent Bridge remote OAuth: registered redirect URIs per client, one-time
 * authorization codes, and hashed access and refresh tokens. Tokens and codes
 * are stored only as SHA-256 hashes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE agent_bridge_clients
    ADD COLUMN redirect_uris_json TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`CREATE TABLE agent_bridge_auth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    project_ids_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`;
  yield* sql`CREATE INDEX agent_bridge_auth_codes_expiry ON agent_bridge_auth_codes(expires_at)`;
  yield* sql`CREATE TABLE agent_bridge_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    resource TEXT NOT NULL,
    grant_generation INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    family_expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT
  )`;
  yield* sql`CREATE INDEX agent_bridge_tokens_expiry ON agent_bridge_tokens(family_expires_at)`;
  yield* sql`CREATE INDEX agent_bridge_tokens_family ON agent_bridge_tokens(family_id)`;
  yield* sql`CREATE INDEX agent_bridge_tokens_client ON agent_bridge_tokens(client_id)`;
});
