import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          last_error_id,
          usage_limit_json,
          auth_failure_json,
          last_error_occurred_at,
          last_error_retryability,
          estimated_context_tokens,
          model_context_window_tokens,
          auto_compact_threshold,
          token_usage_source,
          capabilities_json,
          extension_statuses_json,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId ?? null},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.lastErrorId},
          ${row.usageLimit ? JSON.stringify(row.usageLimit) : null},
          ${row.authFailure ? JSON.stringify(row.authFailure) : null},
          ${row.lastErrorOccurredAt},
          ${row.lastErrorRetryability},
          ${row.estimatedContextTokens},
          ${row.modelContextWindowTokens},
          ${row.autoCompactThreshold ?? null},
          ${row.tokenUsageSource},
          ${row.capabilities ? JSON.stringify(row.capabilities) : null},
          ${JSON.stringify(row.extensionStatuses ?? [])},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          last_error_id = excluded.last_error_id,
          usage_limit_json = excluded.usage_limit_json,
          auth_failure_json = excluded.auth_failure_json,
          last_error_occurred_at = excluded.last_error_occurred_at,
          last_error_retryability = excluded.last_error_retryability,
          estimated_context_tokens = excluded.estimated_context_tokens,
          model_context_window_tokens = excluded.model_context_window_tokens,
          auto_compact_threshold = excluded.auto_compact_threshold,
          token_usage_source = excluded.token_usage_source,
          capabilities_json = excluded.capabilities_json,
          extension_statuses_json = excluded.extension_statuses_json,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSession.mapFields(
      Struct.assign({
        extensionStatuses: Schema.NullOr(
          Schema.fromJsonString(ProjectionThreadSession.fields.extensionStatuses),
        ),
        usageLimit: Schema.NullOr(Schema.fromJsonString(ProjectionThreadSession.fields.usageLimit)),
        authFailure: Schema.NullOr(
          Schema.fromJsonString(ProjectionThreadSession.fields.authFailure),
        ),
        capabilities: Schema.NullOr(
          Schema.fromJsonString(ProjectionThreadSession.fields.capabilities),
        ),
      }),
    ),
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          last_error_id AS "lastErrorId",
          usage_limit_json AS "usageLimit",
          auth_failure_json AS "authFailure",
          last_error_occurred_at AS "lastErrorOccurredAt",
          last_error_retryability AS "lastErrorRetryability",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens",
          auto_compact_threshold AS "autoCompactThreshold",
          token_usage_source AS "tokenUsageSource",
          capabilities_json AS "capabilities",
          extension_statuses_json AS "extensionStatuses",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.map(Option.map((row) => ({ ...row, extensionStatuses: row.extensionStatuses ?? [] }))),
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
