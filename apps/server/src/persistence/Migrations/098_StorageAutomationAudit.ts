import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable, redacted record of what automatic storage cleanup and default
 * branch auto-pull did, and why they skipped a target that a rule matched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS storage_automation_audit (
      audit_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      job TEXT NOT NULL CHECK (job IN ('worktree-cleanup', 'provider-logs', 'auto-pull')),
      policy_version INTEGER NOT NULL,
      target TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT,
      before_ref TEXT,
      after_ref TEXT,
      result TEXT NOT NULL CHECK (result IN ('removed', 'pulled', 'skipped', 'failed')),
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_storage_automation_audit_created_at
    ON storage_automation_audit (created_at)
  `;
});
