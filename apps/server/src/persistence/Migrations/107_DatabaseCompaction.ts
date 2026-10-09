import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bookkeeping for automatic database maintenance:
 *
 * - `orchestration_event_compaction` records, per thread, the event sequence
 *   up to which event compaction has run, so an hourly pass only revisits
 *   threads with newer events, and until when a thread that failed waits.
 * - The storage automation audit accepts the new jobs: event compaction,
 *   automatic thread purges and incremental vacuum. The table is rebuilt under
 *   its own name for the same reasons as migration 106.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_compaction (
      thread_id TEXT PRIMARY KEY,
      compacted_through_sequence INTEGER NOT NULL,
      compacted_at TEXT NOT NULL,
      retry_after TEXT
    )
  `;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE storage_automation_audit_next (
          audit_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          job TEXT NOT NULL CHECK (
            job IN (
              'worktree-cleanup',
              'provider-logs',
              'auto-pull',
              'codex-marketplace-staging',
              'event-compaction',
              'thread-purge',
              'database-vacuum'
            )
          ),
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
        INSERT INTO storage_automation_audit_next (
          audit_id, operation_id, job, policy_version, target, project_id, thread_id,
          before_ref, after_ref, result, reason, created_at
        ) SELECT
          audit_id, operation_id, job, policy_version, target, project_id, thread_id,
          before_ref, after_ref, result, reason, created_at
        FROM storage_automation_audit
      `;
      yield* sql`DROP TABLE storage_automation_audit`;
      yield* sql`PRAGMA legacy_alter_table = ON`;
      yield* sql`ALTER TABLE storage_automation_audit_next RENAME TO storage_automation_audit`.pipe(
        Effect.ensuring(sql`PRAGMA legacy_alter_table = OFF`.pipe(Effect.ignore)),
      );
      yield* sql`
        CREATE INDEX IF NOT EXISTS idx_storage_automation_audit_created_at
        ON storage_automation_audit (created_at)
      `;
    }),
  );
});
