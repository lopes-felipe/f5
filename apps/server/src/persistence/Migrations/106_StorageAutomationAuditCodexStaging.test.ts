import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration098 from "./098_StorageAutomationAudit.ts";
import Migration106 from "./106_StorageAutomationAuditCodexStaging.ts";

const insertAudit = (sql: SqlClient.SqlClient, auditId: string, job: string) =>
  sql`
    INSERT INTO storage_automation_audit (
      audit_id, operation_id, job, policy_version, target, project_id, thread_id,
      before_ref, after_ref, result, reason, created_at
    ) VALUES (
      ${auditId}, 'operation', ${job}, 1, 'project/feature', 'project-1', 'thread-1',
      'abc123', NULL, 'removed', 'idle for 8 days', '2026-10-01T00:00:00.000Z'
    )
  `;

it.layer(SqliteClient.layerMemory())("106_StorageAutomationAuditCodexStaging", (it) => {
  it.effect("keeps the table and its rows, and widens only the job constraint", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration098;
      yield* insertAudit(sql, "existing", "worktree-cleanup");
      // A trigger whose body names a table that does not exist yet, as left by
      // partially repaired search schemas. A modern RENAME re-parses it and fails.
      yield* sql`CREATE TABLE search_source (id TEXT)`;
      yield* sql`
        CREATE TRIGGER search_source_insert AFTER INSERT ON search_source
        BEGIN INSERT INTO search_documents (id) VALUES (new.id); END
      `;

      yield* Migration106;

      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM storage_automation_audit`;
      assert.deepStrictEqual(rows, [
        {
          audit_id: "existing",
          operation_id: "operation",
          job: "worktree-cleanup",
          policy_version: 1,
          target: "project/feature",
          project_id: "project-1",
          thread_id: "thread-1",
          before_ref: "abc123",
          after_ref: null,
          result: "removed",
          reason: "idle for 8 days",
          created_at: "2026-10-01T00:00:00.000Z",
        },
      ]);
      yield* insertAudit(sql, "staging", "codex-marketplace-staging");
      const unknown = yield* Effect.exit(insertAudit(sql, "unknown", "something-else"));
      assert.equal(unknown._tag, "Failure");

      const objects = yield* sql<{ readonly type: string; readonly name: string }>`
        SELECT type, name FROM sqlite_master
        WHERE name LIKE 'storage_automation_audit%' OR name LIKE 'idx_storage_automation_audit%'
        ORDER BY type, name
      `;
      assert.deepStrictEqual(objects, [
        { type: "index", name: "idx_storage_automation_audit_created_at" },
        { type: "table", name: "storage_automation_audit" },
      ]);
      const legacy = yield* sql<{ readonly legacy_alter_table: number }>`
        PRAGMA legacy_alter_table
      `;
      assert.equal(legacy[0]?.legacy_alter_table, 0);
    }),
  );
});
