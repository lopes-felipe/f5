import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionProjectMemoryInput,
  ListProjectionProjectMemoriesByProjectInput,
  ProjectionProjectMemory,
  ProjectionProjectMemoryRepository,
  type ProjectionProjectMemoryRepositoryShape,
} from "../Services/ProjectionProjectMemories.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionProjectMemoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectMemoryRow = SqlSchema.void({
    Request: ProjectionProjectMemory,
    execute: (row) =>
      sql`
        INSERT INTO projection_project_memories (
          memory_id,
          project_id,
          scope,
          type,
          name,
          description,
          body,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.memoryId},
          ${row.projectId},
          ${row.scope},
          ${row.type},
          ${row.name},
          ${row.description},
          ${row.body},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (memory_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          scope = excluded.scope,
          type = excluded.type,
          name = excluded.name,
          description = excluded.description,
          body = excluded.body,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionProjectMemoryRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectMemoryInput,
    Result: ProjectionProjectMemory,
    execute: ({ memoryId }) =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          scope,
          type,
          name,
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_project_memories
        WHERE memory_id = ${memoryId}
      `,
  });

  const listProjectionProjectMemoryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectMemory,
    execute: () =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          scope,
          type,
          name,
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_project_memories
        ORDER BY project_id ASC, updated_at DESC, memory_id ASC
      `,
  });

  const listProjectionProjectMemoryRowsByProjectId = SqlSchema.findAll({
    Request: ListProjectionProjectMemoriesByProjectInput,
    Result: ProjectionProjectMemory,
    execute: ({ projectId }) =>
      sql`
        SELECT
          memory_id AS "memoryId",
          project_id AS "projectId",
          scope,
          type,
          name,
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_project_memories
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC, memory_id ASC
      `,
  });

  const upsert: ProjectionProjectMemoryRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectMemoryRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectMemoryRepository.upsert:query",
          "ProjectionProjectMemoryRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getById: ProjectionProjectMemoryRepositoryShape["getById"] = (input) =>
    getProjectionProjectMemoryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectMemoryRepository.getById:query",
          "ProjectionProjectMemoryRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionProjectMemory>)),
        }),
      ),
    );

  const listAll: ProjectionProjectMemoryRepositoryShape["listAll"] = () =>
    listProjectionProjectMemoryRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectMemoryRepository.listAll:query",
          "ProjectionProjectMemoryRepository.listAll:decodeRows",
        ),
      ),
      Effect.map(
        (rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectMemory>>,
      ),
    );

  const listByProjectId: ProjectionProjectMemoryRepositoryShape["listByProjectId"] = (input) =>
    listProjectionProjectMemoryRowsByProjectId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionProjectMemoryRepository.listByProjectId:query",
          "ProjectionProjectMemoryRepository.listByProjectId:decodeRows",
        ),
      ),
      Effect.map(
        (rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectMemory>>,
      ),
    );

  return {
    upsert,
    getById,
    listAll,
    listByProjectId,
  } satisfies ProjectionProjectMemoryRepositoryShape;
});

export const ProjectionProjectMemoryRepositoryLive = Layer.effect(
  ProjectionProjectMemoryRepository,
  makeProjectionProjectMemoryRepository,
);
