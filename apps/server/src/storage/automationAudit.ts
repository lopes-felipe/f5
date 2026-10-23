import type { StorageAutomationAuditEntry, StorageAutomationJob } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Bumped when an eligibility rule changes meaning, so an audit trail can tell
 * which policy removed (or pulled) a target.
 */
export const STORAGE_AUTOMATION_POLICY_VERSION = 2;

const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const AUDIT_MAX_ROWS = 5_000;

export interface StorageAutomationAuditRecord {
  readonly source?: "automatic" | "manual";
  readonly category?: string;
  readonly reasonCode?: string;
  readonly summary?: { readonly targetCount: number; readonly reclaimedBytes: number };
  readonly operationId: string;
  readonly job: StorageAutomationJob;
  /** Already redacted: relative to the worktrees directory, or a project label. */
  readonly target: string;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
  readonly beforeRef?: string | null;
  readonly afterRef?: string | null;
  readonly result: StorageAutomationAuditEntry["result"];
  readonly reason?: string | null;
}

interface AuditRow {
  readonly auditId: string;
  readonly source: "automatic" | "manual";
  readonly category: string | null;
  readonly reasonCode: string | null;
  readonly summaryJson: string | null;
  readonly operationId: string;
  readonly job: StorageAutomationJob;
  readonly policyVersion: number;
  readonly target: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly beforeRef: string | null;
  readonly afterRef: string | null;
  readonly result: StorageAutomationAuditEntry["result"];
  readonly reason: string | null;
  readonly createdAt: string;
}

/**
 * Best effort: an audit write never fails the cleanup or pull it describes.
 * With `skipIfRepeated`, nothing is written when the newest row for the same
 * job and target already has the same result and reason, so a target that
 * fails on every pass cannot push real history out of the capped table.
 */
export const recordStorageAutomationAudit = (
  record: StorageAutomationAuditRecord,
  options?: { readonly skipIfRepeated?: boolean },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reason = record.reason?.replace(/\s+/g, " ").trim().slice(0, 300) ?? null;
    if (options?.skipIfRepeated) {
      const latest = yield* sql<{ readonly result: string; readonly reason: string | null }>`
        SELECT result, reason FROM storage_automation_audit
        WHERE job = ${record.job} AND target = ${record.target}
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `;
      if (latest[0]?.result === record.result && latest[0]?.reason === reason) {
        return true;
      }
    }
    const createdAt = new Date().toISOString();
    yield* sql`
      INSERT INTO storage_automation_audit (
        audit_id, operation_id, job, policy_version, target, project_id, thread_id,
        before_ref, after_ref, result, reason, created_at, source, category, reason_code, summary_json
      ) VALUES (
        ${crypto.randomUUID()}, ${record.operationId}, ${record.job},
        ${STORAGE_AUTOMATION_POLICY_VERSION}, ${record.target}, ${record.projectId ?? null},
        ${record.threadId ?? null}, ${record.beforeRef ?? null}, ${record.afterRef ?? null},
        ${record.result}, ${reason}, ${createdAt}, ${record.source ?? "automatic"}, ${record.category ?? null}, ${record.reasonCode ?? null}, ${record.summary ? JSON.stringify(record.summary) : null}
      )
    `;
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("storage automation audit write failed", { cause }).pipe(Effect.as(false)),
    ),
  );

export const listStorageAutomationAudit = (limit: number, source?: "automatic" | "manual") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<AuditRow>`
      SELECT
        audit_id AS "auditId", source, category, reason_code AS "reasonCode", summary_json AS "summaryJson",
        operation_id AS "operationId",
        job,
        policy_version AS "policyVersion",
        target,
        project_id AS "projectId",
        thread_id AS "threadId",
        before_ref AS "beforeRef",
        after_ref AS "afterRef",
        result,
        reason,
        created_at AS "createdAt"
      FROM storage_automation_audit
      WHERE (${source ?? null} IS NULL OR source = ${source ?? null})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(({ summaryJson, ...row }) => ({
      ...row,
      reason:
        row.reason
          ?.split(/\n\s+at\s/)[0]
          ?.replace(/\s+/g, " ")
          .slice(0, 300) ?? null,
      summary: summaryJson
        ? (JSON.parse(summaryJson) as StorageAutomationAuditEntry["summary"])
        : null,
    })) satisfies ReadonlyArray<StorageAutomationAuditEntry>;
  });

export const pruneStorageAutomationAudit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_MS).toISOString();
  yield* sql`DELETE FROM storage_automation_audit WHERE created_at < ${cutoff}`;
  yield* sql`
    DELETE FROM storage_automation_audit
    WHERE audit_id NOT IN (
      SELECT audit_id FROM storage_automation_audit
      ORDER BY created_at DESC
      LIMIT ${AUDIT_MAX_ROWS}
    )
  `;
}).pipe(Effect.ignoreCause({ log: true }));
