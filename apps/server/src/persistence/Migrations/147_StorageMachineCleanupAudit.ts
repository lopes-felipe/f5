import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Preserve audit history while extending SQLite's job CHECK constraint. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
      CREATE TABLE storage_automation_audit_next (
        audit_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        job TEXT NOT NULL CHECK(job IN (
          'worktree-cleanup', 'provider-logs', 'auto-pull', 'codex-marketplace-staging',
          'event-compaction', 'thread-purge', 'database-vacuum', 'machine-cleanup'
        )),
        policy_version INTEGER NOT NULL,
        target TEXT NOT NULL,
        project_id TEXT,
        thread_id TEXT,
        before_ref TEXT,
        after_ref TEXT,
        result TEXT NOT NULL CHECK(result IN ('removed', 'pulled', 'skipped', 'failed', 'archiving', 'archived')),
        reason TEXT,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'automatic' CHECK(source IN ('automatic', 'manual')),
        category TEXT,
        reason_code TEXT,
        summary_json TEXT CHECK(summary_json IS NULL OR length(summary_json) <= 4096)
      )
    `;
      yield* sql`
      INSERT INTO storage_automation_audit_next (
        audit_id, operation_id, job, policy_version, target, project_id, thread_id,
        before_ref, after_ref, result, reason, created_at, source, category, reason_code, summary_json
      ) SELECT
        audit_id, operation_id, job, policy_version, target, project_id, thread_id,
        before_ref, after_ref, result, reason, created_at, source, category, reason_code, summary_json
      FROM storage_automation_audit
    `;
      yield* sql`DROP TABLE storage_automation_audit`;
      yield* sql`PRAGMA legacy_alter_table = ON`;
      yield* sql`ALTER TABLE storage_automation_audit_next RENAME TO storage_automation_audit`.pipe(
        Effect.ensuring(sql`PRAGMA legacy_alter_table = OFF`.pipe(Effect.ignore)),
      );
      yield* sql`CREATE INDEX idx_storage_automation_audit_created_at ON storage_automation_audit(created_at)`;
    }),
  );
});
