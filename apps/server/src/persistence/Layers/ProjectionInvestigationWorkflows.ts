import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionInvestigationWorkflowInput,
  GetProjectionInvestigationWorkflowInput,
  ListProjectionInvestigationWorkflowsByProjectInput,
  ProjectionInvestigationWorkflow,
  ProjectionInvestigationWorkflowRepository,
  type ProjectionInvestigationWorkflowRepositoryShape,
} from "../Services/ProjectionInvestigationWorkflows.ts";

const ProjectionInvestigationWorkflowRow = Schema.Struct({
  workflowId: ProjectionInvestigationWorkflow.fields.id,
  projectId: ProjectionInvestigationWorkflow.fields.projectId,
  workflow: Schema.fromJsonString(ProjectionInvestigationWorkflow),
});

const makeProjectionInvestigationWorkflowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionInvestigationWorkflowRow = SqlSchema.void({
    Request: ProjectionInvestigationWorkflow,
    execute: (row) =>
      sql`
        INSERT INTO projection_investigation_workflows (
          workflow_id,
          project_id,
          workflow_json,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.id},
          ${row.projectId},
          ${JSON.stringify(row)},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (workflow_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          workflow_json = excluded.workflow_json,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionInvestigationWorkflowRow = SqlSchema.findOneOption({
    Request: GetProjectionInvestigationWorkflowInput,
    Result: ProjectionInvestigationWorkflowRow,
    execute: ({ workflowId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_investigation_workflows
        WHERE workflow_id = ${workflowId}
      `,
  });

  const listProjectionInvestigationWorkflowRows = SqlSchema.findAll({
    Request: ListProjectionInvestigationWorkflowsByProjectInput,
    Result: ProjectionInvestigationWorkflowRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_investigation_workflows
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const listAllProjectionInvestigationWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionInvestigationWorkflowRow,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_investigation_workflows
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const deleteProjectionInvestigationWorkflowRow = SqlSchema.void({
    Request: DeleteProjectionInvestigationWorkflowInput,
    execute: ({ workflowId, deletedAt }) =>
      sql`
        UPDATE projection_investigation_workflows
        SET
          deleted_at = ${deletedAt},
          workflow_json = json_set(
            json_set(workflow_json, '$.deletedAt', ${deletedAt}),
            '$.updatedAt',
            ${deletedAt}
          ),
          updated_at = ${deletedAt}
        WHERE workflow_id = ${workflowId}
      `,
  });

  const upsert: ProjectionInvestigationWorkflowRepositoryShape["upsert"] = (workflow) =>
    upsertProjectionInvestigationWorkflowRow(workflow).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInvestigationWorkflowRepository.upsert:query"),
      ),
    );

  const getById: ProjectionInvestigationWorkflowRepositoryShape["getById"] = (input) =>
    getProjectionInvestigationWorkflowRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInvestigationWorkflowRepository.getById:query"),
      ),
      Effect.map((row) => Option.map(row, (entry) => entry.workflow)),
    );

  const listByProjectId: ProjectionInvestigationWorkflowRepositoryShape["listByProjectId"] = (
    input,
  ) =>
    listProjectionInvestigationWorkflowRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInvestigationWorkflowRepository.listByProjectId:query"),
      ),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const listAll: ProjectionInvestigationWorkflowRepositoryShape["listAll"] = () =>
    listAllProjectionInvestigationWorkflowRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInvestigationWorkflowRepository.listAll:query"),
      ),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const deleteById: ProjectionInvestigationWorkflowRepositoryShape["deleteById"] = (input) =>
    deleteProjectionInvestigationWorkflowRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionInvestigationWorkflowRepository.deleteById:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    listAll,
    deleteById,
  } satisfies ProjectionInvestigationWorkflowRepositoryShape;
});

export const ProjectionInvestigationWorkflowRepositoryLive = Layer.effect(
  ProjectionInvestigationWorkflowRepository,
  makeProjectionInvestigationWorkflowRepository,
);
