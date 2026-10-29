import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration098 from "./098_StorageAutomationAudit.ts";
import Migration106 from "./106_StorageAutomationAuditCodexStaging.ts";
import Migration107 from "./107_DatabaseCompaction.ts";
import Migration122 from "./122_StorageActivity.ts";
import Migration147 from "./147_StorageMachineCleanupAudit.ts";

it.layer(SqliteClient.layerMemory())("147_StorageMachineCleanupAudit", (it) => {
  it.effect("preserves all audit fields and constraints while accepting machine cleanup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration098;
      yield* Migration106;
      yield* Migration107;
      yield* Migration122;
      yield* sql`INSERT INTO storage_automation_audit (
        audit_id, operation_id, job, policy_version, target, result, created_at,
        source, category, reason_code, summary_json
      ) VALUES ('existing', 'op', 'worktree-cleanup', 1, 'checkout', 'skipped', '2026-10-29',
        'manual', 'inactiveF5Worktrees', 'archived-awaiting-removal', '{"targetCount":1}')`;
      const before = yield* sql`SELECT * FROM storage_automation_audit`;
      yield* Migration147;
      assert.deepEqual(yield* sql`SELECT * FROM storage_automation_audit`, before);
      yield* sql`INSERT INTO storage_automation_audit (
        audit_id, operation_id, job, policy_version, target, result, created_at, source
      ) VALUES ('machine', 'op', 'machine-cleanup', 1, 'cache', 'removed', '2026-10-29', 'manual')`;
      assert.equal((yield* sql`SELECT * FROM storage_automation_audit`).length, 2);
      assert.equal(
        (yield* Effect.exit(sql`UPDATE storage_automation_audit SET job = 'unknown'`))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(sql`UPDATE storage_automation_audit SET source = 'unknown'`))._tag,
        "Failure",
      );
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE name = 'idx_storage_automation_audit_created_at'`)
          .length,
        1,
      );
    }),
  );
});
