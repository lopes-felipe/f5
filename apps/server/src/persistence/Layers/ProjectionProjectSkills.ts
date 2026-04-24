import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionProjectSkillsByProjectInput,
  ListProjectionProjectSkillsByProjectInput,
  ProjectionProjectSkill,
  ProjectionProjectSkillRepository,
  type ProjectionProjectSkillRepositoryShape,
} from "../Services/ProjectionProjectSkills.ts";

const ProjectionProjectSkillDbRowSchema = ProjectionProjectSkill.mapFields(
  Struct.assign({
    allowedTools: Schema.fromJsonString(ProjectionProjectSkill.fields.allowedTools),
    paths: Schema.fromJsonString(ProjectionProjectSkill.fields.paths),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionProjectSkillRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertProjectionProjectSkillRow = SqlSchema.void({
    Request: ProjectionProjectSkill,
    execute: (row) =>
      sql`
        INSERT INTO projection_project_skills (
          skill_id,
          project_id,
          scope,
          command_name,
          display_name,
          description,
          argument_hint,
          allowed_tools_json,
          paths_json,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.projectId},
          ${row.scope},
          ${row.commandName},
          ${row.displayName},
          ${row.description},
          ${row.argumentHint},
          ${JSON.stringify(row.allowedTools)},
          ${JSON.stringify(row.paths)},
          ${row.updatedAt}
        )
      `,
  });

  const replaceForProject: ProjectionProjectSkillRepositoryShape["replaceForProject"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM projection_project_skills
            WHERE project_id = ${input.projectId}
          `;

          yield* Effect.forEach(input.skills, (skill) => insertProjectionProjectSkillRow(skill), {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionProjectSkillRepository.replaceForProject:query",
            "ProjectionProjectSkillRepository.replaceForProject:encodeRequest",
          ),
        ),
      );

  const deleteByProjectId: ProjectionProjectSkillRepositoryShape["deleteByProjectId"] = (input) =>
    SqlSchema.void({
      Request: DeleteProjectionProjectSkillsByProjectInput,
      execute: ({ projectId }) =>
        sql`
          DELETE FROM projection_project_skills
          WHERE project_id = ${projectId}
        `,
    })(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectSkillRepository.deleteByProjectId:query"),
      ),
    );

  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectSkillDbRowSchema,
    execute: () =>
      sql`
        SELECT
          skill_id AS "id",
          project_id AS "projectId",
          scope,
          command_name AS "commandName",
          display_name AS "displayName",
          description,
          argument_hint AS "argumentHint",
          allowed_tools_json AS "allowedTools",
          paths_json AS "paths",
          updated_at AS "updatedAt"
        FROM projection_project_skills
        ORDER BY project_id ASC, command_name ASC, scope ASC, skill_id ASC
      `,
  });

  const listByProjectId = SqlSchema.findAll({
    Request: ListProjectionProjectSkillsByProjectInput,
    Result: ProjectionProjectSkillDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          skill_id AS "id",
          project_id AS "projectId",
          scope,
          command_name AS "commandName",
          display_name AS "displayName",
          description,
          argument_hint AS "argumentHint",
          allowed_tools_json AS "allowedTools",
          paths_json AS "paths",
          updated_at AS "updatedAt"
        FROM projection_project_skills
        WHERE project_id = ${projectId}
        ORDER BY command_name ASC, scope ASC, skill_id ASC
      `,
  });

  return {
    replaceForProject,
    deleteByProjectId,
    listAll: () =>
      listAll().pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionProjectSkillRepository.listAll:query",
            "ProjectionProjectSkillRepository.listAll:decodeRows",
          ),
        ),
        Effect.map(
          (rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectSkill>>,
        ),
      ),
    listByProjectId: (input) =>
      listByProjectId(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionProjectSkillRepository.listByProjectId:query",
            "ProjectionProjectSkillRepository.listByProjectId:decodeRows",
          ),
        ),
        Effect.map(
          (rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectSkill>>,
        ),
      ),
  } satisfies ProjectionProjectSkillRepositoryShape;
});

export const ProjectionProjectSkillRepositoryLive = Layer.effect(
  ProjectionProjectSkillRepository,
  makeProjectionProjectSkillRepository,
);
