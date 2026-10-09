import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Tool-result screenshots are attachments owned by the thread activity that produced them. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'`;
  // Schema repair fixtures can omit the attachment subsystem entirely.
  if (!tables.length) return;
  yield* sql`CREATE TABLE IF NOT EXISTS attachment_owners (attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(attachment_id, owner_kind, owner_id))`;
  yield* sql`CREATE TABLE attachment_owners_v3 (
    attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('ingress', 'queue_item', 'message', 'user_input', 'rewind_draft', 'activity')),
    owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (attachment_id, owner_kind, owner_id)
  )`;
  yield* sql`INSERT INTO attachment_owners_v3 SELECT * FROM attachment_owners`;
  yield* sql`DROP TABLE attachment_owners`;
  yield* sql`CREATE TABLE attachment_owners (
    attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('ingress', 'queue_item', 'message', 'user_input', 'rewind_draft', 'activity')),
    owner_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (attachment_id, owner_kind, owner_id)
  )`;
  yield* sql`INSERT INTO attachment_owners SELECT * FROM attachment_owners_v3`;
  yield* sql`DROP TABLE attachment_owners_v3`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_attachment_owners_owner ON attachment_owners(owner_kind, owner_id)`;
});
