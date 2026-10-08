import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration098 from "./098_StorageAutomationAudit.ts";
import Migration106 from "./106_StorageAutomationAuditCodexStaging.ts";
import Migration107 from "./107_DatabaseCompaction.ts";

const insertAudit = (sql: SqlClient.SqlClient, auditId: string, job: string) =>
  sql`
    INSERT INTO storage_automation_audit (
      audit_id, operation_id, job, policy_version, target, project_id, thread_id,
      before_ref, after_ref, result, reason, created_at
    ) VALUES (
      ${auditId}, 'operation', ${job}, 1, 'target', NULL, NULL,
      NULL, NULL, 'removed', 'reason', '2026-10-01T00:00:00.000Z'
    )
  `;

it.layer(SqliteClient.layerMemory())("107_DatabaseCompaction", (it) => {
  it.effect("keeps audit rows, accepts the maintenance jobs and adds the compaction table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration098;
      yield* Migration106;
      yield* insertAudit(sql, "existing", "codex-marketplace-staging");

      yield* Migration107;

      const rows = yield* sql<{ readonly auditId: string; readonly job: string }>`
        SELECT audit_id AS "auditId", job FROM storage_automation_audit
      `;
      assert.deepStrictEqual(rows, [{ auditId: "existing", job: "codex-marketplace-staging" }]);
      for (const job of ["event-compaction", "thread-purge", "database-vacuum"]) {
        yield* insertAudit(sql, job, job);
      }
      const unknown = yield* Effect.exit(insertAudit(sql, "unknown", "something-else"));
      assert.equal(unknown._tag, "Failure");

      yield* sql`
        INSERT INTO orchestration_event_compaction (
          thread_id, compacted_through_sequence, compacted_at
        ) VALUES ('thread-1', 42, '2026-10-01T00:00:00.000Z')
      `;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_storage_automation_audit_created_at'
      `;
      assert.equal(indexes.length, 1);
    }),
  );
});
