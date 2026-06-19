import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0050 from "./050_CopyDebugWorkflowsToInvestigationWorkflows.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("050_CopyDebugWorkflowsToInvestigationWorkflows", (it) => {
  it.effect("does not create the legacy debug projection table on fresh databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* Migration0050;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('projection_investigation_workflows', 'projection_debug_workflows')
        ORDER BY name ASC
      `;

      assert.deepEqual(
        tables.map((table) => table.name),
        ["projection_investigation_workflows"],
      );
    }),
  );

  it.effect("copies legacy debug projection rows into investigation projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workflowJson = JSON.stringify({
        id: "workflow-1",
        projectId: "project-1",
        updatedAt: "2026-06-19T10:00:00.000Z",
        deletedAt: null,
      });

      yield* sql`
        CREATE TABLE projection_debug_workflows (
          workflow_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          workflow_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        )
      `;
      yield* sql`
        INSERT INTO projection_debug_workflows (
          workflow_id,
          project_id,
          workflow_json,
          updated_at,
          deleted_at
        )
        VALUES (
          'workflow-1',
          'project-1',
          ${workflowJson},
          '2026-06-19T10:00:00.000Z',
          NULL
        )
      `;

      yield* Migration0050;
      yield* Migration0050;

      const rows = yield* sql<{
        readonly workflowId: string;
        readonly projectId: string;
        readonly workflowJson: string;
        readonly updatedAt: string;
        readonly deletedAt: string | null;
      }>`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflowJson",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_investigation_workflows
        ORDER BY workflow_id ASC
      `;

      assert.deepEqual(rows, [
        {
          workflowId: "workflow-1",
          projectId: "project-1",
          workflowJson,
          updatedAt: "2026-06-19T10:00:00.000Z",
          deletedAt: null,
        },
      ]);
    }),
  );
});
