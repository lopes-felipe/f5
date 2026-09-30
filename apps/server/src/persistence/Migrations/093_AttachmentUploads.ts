import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE attachment_uploads (
      upload_id TEXT PRIMARY KEY,
      draft_thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('image', 'file')),
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      content_hash TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_draft_touch_at TEXT,
      claim_lease_until TEXT,
      source TEXT CHECK(source IN ('pasted-text', 'snapshot'))
    )
  `;
  yield* sql`CREATE TABLE attachment_upload_claims (
    claim_id TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL REFERENCES attachment_uploads(upload_id) ON DELETE CASCADE,
    lease_until TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_attachment_uploads_draft ON attachment_uploads(draft_thread_id)`;
  yield* sql`CREATE INDEX idx_attachment_uploads_expiry ON attachment_uploads(expires_at)`;
});
