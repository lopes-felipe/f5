import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { McpProjectServersConfig } from "@t3tools/contracts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectMcpConfigInput,
  ProjectMcpConfigRecord,
  ProjectMcpConfigRepository,
  ReplaceProjectMcpConfigInput,
  type ProjectMcpConfigRepositoryShape,
} from "../Services/ProjectMcpConfigs.ts";

const ProjectMcpConfigDbRowSchema = ProjectMcpConfigRecord.mapFields(
  Struct.assign({
    servers: Schema.fromJsonString(McpProjectServersConfig),
  }),
);

const ReplaceProjectMcpConfigDbRequestSchema = ReplaceProjectMcpConfigInput.mapFields(
  Struct.assign({
    servers: Schema.fromJsonString(McpProjectServersConfig),
    scopeKey: Schema.String,
  }),
);

const GetProjectMcpConfigDbRequestSchema = GetProjectMcpConfigInput.mapFields(
  Struct.assign({
    scopeKey: Schema.String,
  }),
);

function scopeKeyFor(input: {
  readonly scope: "common" | "project";
  readonly projectId: string | null;
}): string {
  return input.scope === "common" ? "common" : `project:${input.projectId ?? ""}`;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectMcpConfigRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getProjectMcpConfigRow = SqlSchema.findOneOption({
    Request: GetProjectMcpConfigDbRequestSchema,
    Result: ProjectMcpConfigDbRowSchema,
    execute: ({ scopeKey }) =>
      sql`
        SELECT
          scope,
          project_id AS "projectId",
          version,
          servers_json AS "servers",
          updated_at AS "updatedAt"
        FROM project_mcp_configs
        WHERE scope_key = ${scopeKey}
      `,
  });

  const replaceProjectMcpConfigRow = SqlSchema.findOneOption({
    Request: ReplaceProjectMcpConfigDbRequestSchema,
    Result: ProjectMcpConfigDbRowSchema,
    execute: ({ scopeKey, scope, projectId, expectedVersion, nextVersion, servers, updatedAt }) =>
      sql`
        WITH existing AS (
          SELECT version
          FROM project_mcp_configs
          WHERE scope_key = ${scopeKey}
        )
        INSERT INTO project_mcp_configs (
          scope_key,
          scope,
          project_id,
          version,
          servers_json,
          updated_at
        )
        SELECT
          ${scopeKey},
          ${scope},
          ${projectId},
          ${nextVersion},
          ${servers},
          ${updatedAt}
        WHERE
          (${expectedVersion} IS NULL AND NOT EXISTS (SELECT 1 FROM existing))
          OR EXISTS (SELECT 1 FROM existing WHERE version = ${expectedVersion})
        ON CONFLICT (scope_key)
        DO UPDATE SET
          scope = excluded.scope,
          project_id = excluded.project_id,
          version = excluded.version,
          servers_json = excluded.servers_json,
          updated_at = excluded.updated_at
        WHERE project_mcp_configs.version = ${expectedVersion}
        RETURNING
          scope,
          project_id AS "projectId",
          version,
          servers_json AS "servers",
          updated_at AS "updatedAt"
      `,
  });

  const get: ProjectMcpConfigRepositoryShape["get"] = (input) =>
    getProjectMcpConfigRow({
      ...input,
      scopeKey: scopeKeyFor(input),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectMcpConfigRepository.get:query",
          "ProjectMcpConfigRepository.get:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectMcpConfigRecord>)),
        }),
      ),
    );

  const replaceIfVersionMatches: ProjectMcpConfigRepositoryShape["replaceIfVersionMatches"] = (
    input,
  ) =>
    replaceProjectMcpConfigRow({
      ...input,
      scopeKey: scopeKeyFor(input),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectMcpConfigRepository.replaceIfVersionMatches:query",
          "ProjectMcpConfigRepository.replaceIfVersionMatches:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectMcpConfigRecord>)),
        }),
      ),
    );

  return {
    get,
    replaceIfVersionMatches,
  } satisfies ProjectMcpConfigRepositoryShape;
});

export const ProjectMcpConfigRepositoryLive = Layer.effect(
  ProjectMcpConfigRepository,
  makeProjectMcpConfigRepository,
);
