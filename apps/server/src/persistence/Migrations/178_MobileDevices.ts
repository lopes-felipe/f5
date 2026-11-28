import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS mobile_devices (
    device_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    push_token TEXT,
    push_environment TEXT,
    notify_json TEXT
  )`;
});
