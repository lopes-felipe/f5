import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0037 from "./037_CleanupInvalidProjectionPendingApprovals.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("037_CleanupInvalidProjectionPendingApprovals", (it) => {
  it.effect("removes pending approvals that were created from user-input request ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_thread_activities (
          activity_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          tone TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `;

      yield* sql`
        CREATE TABLE projection_pending_approvals (
          request_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-approval-requested',
            'thread-valid',
            'turn-valid',
            'approval',
            'approval.requested',
            'Command approval requested',
            '{"requestId":"approval-valid","requestKind":"command"}',
            '2026-04-13T00:01:00.000Z'
          ),
          (
            'activity-user-input-requested',
            'thread-invalid',
            'turn-invalid',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-invalid"}',
            '2026-04-13T00:02:00.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES
          (
            'approval-valid',
            'thread-valid',
            'turn-valid',
            'pending',
            NULL,
            '2026-04-13T00:01:00.000Z',
            NULL
          ),
          (
            'input-invalid',
            'thread-invalid',
            'turn-invalid',
            'pending',
            NULL,
            '2026-04-13T00:02:00.000Z',
            NULL
          ),
	          (
	            'orphan-invalid',
	            'thread-invalid',
	            'turn-invalid',
	            'pending',
	            NULL,
	            '2026-04-13T00:03:00.000Z',
	            NULL
	          ),
	          (
	            'orphan-resolved',
	            'thread-invalid',
	            'turn-invalid',
	            'resolved',
	            'approved',
	            '2026-04-13T00:04:00.000Z',
	            '2026-04-13T00:05:00.000Z'
	          )
	      `;

      yield* Migration0037;

      const rows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
      }>`
        SELECT request_id AS "requestId", status
        FROM projection_pending_approvals
        ORDER BY request_id ASC
      `;

      assert.deepEqual(rows, [
        {
          requestId: "approval-valid",
          status: "pending",
        },
        {
          requestId: "orphan-resolved",
          status: "resolved",
        },
      ]);
    }),
  );
});
