import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionPlanningWorkflowInput,
  GetProjectionPlanningWorkflowInput,
  ListProjectionPlanningWorkflowsByProjectInput,
  ProjectionPlanningWorkflow,
  ProjectionPlanningWorkflowRepository,
  type ProjectionPlanningWorkflowRepositoryShape,
} from "../Services/ProjectionPlanningWorkflows.ts";

const ProjectionPlanningWorkflowRow = Schema.Struct({
  workflowId: ProjectionPlanningWorkflow.fields.id,
  projectId: ProjectionPlanningWorkflow.fields.projectId,
  workflow: Schema.fromJsonString(ProjectionPlanningWorkflow),
});

const makeProjectionPlanningWorkflowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPlanningWorkflowRow = SqlSchema.void({
    Request: ProjectionPlanningWorkflow,
    execute: (row) =>
      sql`
        INSERT INTO projection_planning_workflows (
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

  const getProjectionPlanningWorkflowRow = SqlSchema.findOneOption({
    Request: GetProjectionPlanningWorkflowInput,
    Result: ProjectionPlanningWorkflowRow,
    execute: ({ workflowId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_planning_workflows
        WHERE workflow_id = ${workflowId}
      `,
  });

  const listProjectionPlanningWorkflowRows = SqlSchema.findAll({
    Request: ListProjectionPlanningWorkflowsByProjectInput,
    Result: ProjectionPlanningWorkflowRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_planning_workflows
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const listAllProjectionPlanningWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionPlanningWorkflowRow,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_planning_workflows
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const deleteProjectionPlanningWorkflowRow = SqlSchema.void({
    Request: DeleteProjectionPlanningWorkflowInput,
    execute: ({ workflowId, deletedAt }) =>
      sql`
        UPDATE projection_planning_workflows
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

  const upsert: ProjectionPlanningWorkflowRepositoryShape["upsert"] = (workflow) =>
    upsertProjectionPlanningWorkflowRow(workflow).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPlanningWorkflowRepository.upsert:query")),
    );

  const getById: ProjectionPlanningWorkflowRepositoryShape["getById"] = (input) =>
    getProjectionPlanningWorkflowRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPlanningWorkflowRepository.getById:query")),
      Effect.map((row) => Option.map(row, (entry) => entry.workflow)),
    );

  const listByProjectId: ProjectionPlanningWorkflowRepositoryShape["listByProjectId"] = (input) =>
    listProjectionPlanningWorkflowRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPlanningWorkflowRepository.listByProjectId:query"),
      ),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const listAll: ProjectionPlanningWorkflowRepositoryShape["listAll"] = () =>
    listAllProjectionPlanningWorkflowRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPlanningWorkflowRepository.listAll:query")),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const deleteById: ProjectionPlanningWorkflowRepositoryShape["deleteById"] = (input) =>
    deleteProjectionPlanningWorkflowRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPlanningWorkflowRepository.deleteById:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    listAll,
    deleteById,
  } satisfies ProjectionPlanningWorkflowRepositoryShape;
});

export const ProjectionPlanningWorkflowRepositoryLive = Layer.effect(
  ProjectionPlanningWorkflowRepository,
  makeProjectionPlanningWorkflowRepository,
);
