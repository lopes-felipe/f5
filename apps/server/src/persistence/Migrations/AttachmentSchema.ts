import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Ensures the durable attachment registry and cleanup schema exists. */
export const ensureAttachmentSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS attachments (
      attachment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      content_hash TEXT NOT NULL,
      staging_path TEXT,
      final_path TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('staged', 'ready', 'deleting')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_owners (
      attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('ingress', 'queue_item', 'message')),
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (attachment_id, owner_kind, owner_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
      attachment_id TEXT PRIMARY KEY REFERENCES attachments(attachment_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      not_before TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_owners_owner
    ON attachment_owners(owner_kind, owner_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_jobs_actionable
    ON attachment_cleanup_jobs(not_before, created_at)
  `;
});
