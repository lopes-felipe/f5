import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Allow the `codex-marketplace-staging` job in the storage automation audit:
 * the sweep that removes leaked Codex marketplace upgrade clones. SQLite
 * cannot alter a CHECK constraint, so the table is rebuilt under its own name,
 * which keeps older builds reading the same table after a downgrade.
 *
 * The rename runs with `legacy_alter_table` on. Otherwise SQLite re-parses
 * every trigger in the schema during the rename, and that fails on databases
 * whose search triggers point at tables an earlier repair migration has not
 * created yet. Nothing references the audit table, so there is nothing for the
 * modern rename to rewrite.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE storage_automation_audit_next (
          audit_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          job TEXT NOT NULL CHECK (
            job IN ('worktree-cleanup', 'provider-logs', 'auto-pull', 'codex-marketplace-staging')
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
      // Named columns: the source layout lives in migration 098.
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
