import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  listStorageAutomationAudit,
  pruneStorageAutomationAudit,
  readSkipsSinceLastSuccess,
  recordStorageAutomationAudit,
} from "./automationAudit.ts";

it.layer(SqlitePersistenceMemory)("recordStorageAutomationAudit", (it) => {
  it.effect("skips a row that repeats the newest result and reason for its target", () =>
    Effect.gen(function* () {
      const failed = (target: string, reason: string, operationId: string) =>
        recordStorageAutomationAudit(
          {
            operationId,
            job: "codex-marketplace-staging",
            target,
            result: "failed",
            reason,
          },
          { skipIfRepeated: true },
        );

      yield* failed("~/.codex/a", "EACCES", "pass-1");
      yield* failed("~/.codex/a", "EACCES", "pass-2");
      yield* failed("~/.codex/b", "EACCES", "pass-2");
      yield* failed("~/.codex/a", "EBUSY", "pass-3");
      // Without the option every pass is recorded.
      yield* recordStorageAutomationAudit({
        operationId: "pass-4",
        job: "codex-marketplace-staging",
        target: "~/.codex/a",
        result: "failed",
        reason: "EBUSY",
      });

      const rows = yield* listStorageAutomationAudit(10);
      assert.deepStrictEqual(
        rows.map((row) => [row.operationId, row.target, row.reason]).toSorted(),
        [
          ["pass-1", "~/.codex/a", "EACCES"],
          ["pass-2", "~/.codex/b", "EACCES"],
          ["pass-3", "~/.codex/a", "EBUSY"],
          ["pass-4", "~/.codex/a", "EBUSY"],
        ],
      );
    }),
  );

  it.effect("finds when a job started skipping and resets after a success", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = (result: string, reason: string, createdAt: string) => sql`
        INSERT INTO storage_automation_audit (
          audit_id, operation_id, job, policy_version, target, result, reason, created_at, source
        ) VALUES (
          ${crypto.randomUUID()}, ${"op"}, ${"database-vacuum"}, ${3}, ${"state database"},
          ${result}, ${reason}, ${createdAt}, ${"automatic"}
        )
      `;
      assert.deepStrictEqual(yield* readSkipsSinceLastSuccess("database-vacuum"), {
        waitingSince: null,
        lastSkipReason: null,
      });
      yield* insert("skipped", "an agent is working", "2026-10-01T00:00:00.000Z");
      yield* insert("removed", "converted", "2026-10-05T00:00:00.000Z");
      yield* insert("skipped", "an agent is working", "2026-10-09T00:00:00.000Z");
      yield* insert("skipped", "a thread was used recently", "2026-10-30T00:00:00.000Z");
      assert.deepStrictEqual(yield* readSkipsSinceLastSuccess("database-vacuum"), {
        waitingSince: "2026-10-09T00:00:00.000Z",
        lastSkipReason: "a thread was used recently",
      });
      yield* insert("removed", "converted by hand", "2026-10-31T00:00:00.000Z");
      assert.deepStrictEqual(yield* readSkipsSinceLastSuccess("database-vacuum"), {
        waitingSince: null,
        lastSkipReason: null,
      });
    }),
  );

  it.effect("keeps the skip that dates a stuck compaction past the age and row limits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM storage_automation_audit`;
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
      const insert = (job: string, result: string, createdAt: string) => sql`
        INSERT INTO storage_automation_audit (
          audit_id, operation_id, job, policy_version, target, result, reason, created_at, source
        ) VALUES (
          ${crypto.randomUUID()}, ${"op"}, ${job}, ${3}, ${"state database"},
          ${result}, ${"reason"}, ${createdAt}, ${"automatic"}
        )
      `;
      const firstSkip = daysAgo(150);
      yield* insert("database-vacuum", "removed", daysAgo(200));
      yield* insert("database-vacuum", "skipped", firstSkip);
      yield* insert("database-vacuum", "skipped", daysAgo(120));
      // More recent rows than the cap keeps.
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001)
        INSERT INTO storage_automation_audit (
          audit_id, operation_id, job, policy_version, target, result, reason, created_at, source
        )
        SELECT 'bulk-' || i, 'op', 'auto-pull', 3, 'repo', 'pulled', 'ok', ${daysAgo(1)}, 'automatic'
        FROM n
      `;
      yield* pruneStorageAutomationAudit;
      assert.equal((yield* readSkipsSinceLastSuccess("database-vacuum")).waitingSince, firstSkip);
      const vacuumRows = yield* sql<{ readonly result: string }>`
        SELECT result FROM storage_automation_audit WHERE job = 'database-vacuum'
      `;
      assert.deepStrictEqual(
        vacuumRows.map((row) => row.result),
        ["skipped"],
      );
      const [{ count } = { count: 0 }] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM storage_automation_audit
      `;
      assert.equal(count, 5_001);
    }),
  );
});
