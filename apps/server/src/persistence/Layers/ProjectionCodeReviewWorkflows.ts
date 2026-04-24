import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionCodeReviewWorkflowInput,
  GetProjectionCodeReviewWorkflowInput,
  ListProjectionCodeReviewWorkflowsByProjectInput,
  ProjectionCodeReviewWorkflow,
  ProjectionCodeReviewWorkflowRepository,
  type ProjectionCodeReviewWorkflowRepositoryShape,
} from "../Services/ProjectionCodeReviewWorkflows.ts";

const ProjectionCodeReviewWorkflowRow = Schema.Struct({
  workflowId: ProjectionCodeReviewWorkflow.fields.id,
  projectId: ProjectionCodeReviewWorkflow.fields.projectId,
  workflow: Schema.fromJsonString(ProjectionCodeReviewWorkflow),
});

const makeProjectionCodeReviewWorkflowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionCodeReviewWorkflowRow = SqlSchema.void({
    Request: ProjectionCodeReviewWorkflow,
    execute: (row) =>
      sql`
        INSERT INTO projection_code_review_workflows (
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

  const getProjectionCodeReviewWorkflowRow = SqlSchema.findOneOption({
    Request: GetProjectionCodeReviewWorkflowInput,
    Result: ProjectionCodeReviewWorkflowRow,
    execute: ({ workflowId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_code_review_workflows
        WHERE workflow_id = ${workflowId}
      `,
  });

  const listProjectionCodeReviewWorkflowRows = SqlSchema.findAll({
    Request: ListProjectionCodeReviewWorkflowsByProjectInput,
    Result: ProjectionCodeReviewWorkflowRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_code_review_workflows
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const listAllProjectionCodeReviewWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCodeReviewWorkflowRow,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          project_id AS "projectId",
          workflow_json AS "workflow"
        FROM projection_code_review_workflows
        ORDER BY updated_at DESC, workflow_id DESC
      `,
  });

  const deleteProjectionCodeReviewWorkflowRow = SqlSchema.void({
    Request: DeleteProjectionCodeReviewWorkflowInput,
    execute: ({ workflowId, deletedAt }) =>
      sql`
        UPDATE projection_code_review_workflows
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

  const upsert: ProjectionCodeReviewWorkflowRepositoryShape["upsert"] = (workflow) =>
    upsertProjectionCodeReviewWorkflowRow(workflow).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionCodeReviewWorkflowRepository.upsert:query")),
    );

  const getById: ProjectionCodeReviewWorkflowRepositoryShape["getById"] = (input) =>
    getProjectionCodeReviewWorkflowRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCodeReviewWorkflowRepository.getById:query"),
      ),
      Effect.map((row) => Option.map(row, (entry) => entry.workflow)),
    );

  const listByProjectId: ProjectionCodeReviewWorkflowRepositoryShape["listByProjectId"] = (input) =>
    listProjectionCodeReviewWorkflowRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCodeReviewWorkflowRepository.listByProjectId:query"),
      ),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const listAll: ProjectionCodeReviewWorkflowRepositoryShape["listAll"] = () =>
    listAllProjectionCodeReviewWorkflowRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCodeReviewWorkflowRepository.listAll:query"),
      ),
      Effect.map((rows) => rows.map((entry) => entry.workflow)),
    );

  const deleteById: ProjectionCodeReviewWorkflowRepositoryShape["deleteById"] = (input) =>
    deleteProjectionCodeReviewWorkflowRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCodeReviewWorkflowRepository.deleteById:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    listAll,
    deleteById,
  } satisfies ProjectionCodeReviewWorkflowRepositoryShape;
});

export const ProjectionCodeReviewWorkflowRepositoryLive = Layer.effect(
  ProjectionCodeReviewWorkflowRepository,
  makeProjectionCodeReviewWorkflowRepository,
);
