import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";
import { TrimmedNonEmptyString } from "@t3tools/contracts";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadCommandExecutionsByThreadInput,
  GetProjectionThreadCommandExecutionByIdInput,
  GetProjectionThreadCommandExecutionsLatestSequenceInput,
  ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput,
  ListProjectionThreadCommandExecutionsByThreadInput,
  ProjectionThreadCommandExecution,
  ProjectionThreadCommandExecutionSummary,
  ProjectionThreadCommandExecutionRepository,
  type ProjectionThreadCommandExecutionRepositoryShape,
} from "../Services/ProjectionThreadCommandExecutions.ts";

const ProjectionThreadCommandExecutionDbRowSchema = Schema.Struct({
  id: ProjectionThreadCommandExecution.fields.id,
  threadId: ProjectionThreadCommandExecution.fields.threadId,
  turnId: ProjectionThreadCommandExecution.fields.turnId,
  providerItemId: ProjectionThreadCommandExecution.fields.providerItemId,
  command: ProjectionThreadCommandExecution.fields.command,
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  title: ProjectionThreadCommandExecution.fields.title,
  status: ProjectionThreadCommandExecution.fields.status,
  detail: ProjectionThreadCommandExecution.fields.detail,
  output: ProjectionThreadCommandExecution.fields.output,
  outputTruncated: Schema.Int,
  exitCode: ProjectionThreadCommandExecution.fields.exitCode,
  startedAt: ProjectionThreadCommandExecution.fields.startedAt,
  completedAt: ProjectionThreadCommandExecution.fields.completedAt,
  updatedAt: ProjectionThreadCommandExecution.fields.updatedAt,
  startedSequence: ProjectionThreadCommandExecution.fields.startedSequence,
  lastUpdatedSequence: ProjectionThreadCommandExecution.fields.lastUpdatedSequence,
});
type ProjectionThreadCommandExecutionDbRow =
  typeof ProjectionThreadCommandExecutionDbRowSchema.Type;

export const ProjectionThreadCommandExecutionSummaryDbRowSchema = Schema.Struct({
  id: ProjectionThreadCommandExecutionSummary.fields.id,
  threadId: ProjectionThreadCommandExecutionSummary.fields.threadId,
  turnId: ProjectionThreadCommandExecutionSummary.fields.turnId,
  providerItemId: ProjectionThreadCommandExecutionSummary.fields.providerItemId,
  command: ProjectionThreadCommandExecutionSummary.fields.command,
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  title: ProjectionThreadCommandExecutionSummary.fields.title,
  status: ProjectionThreadCommandExecutionSummary.fields.status,
  detail: ProjectionThreadCommandExecutionSummary.fields.detail,
  exitCode: ProjectionThreadCommandExecutionSummary.fields.exitCode,
  startedAt: ProjectionThreadCommandExecutionSummary.fields.startedAt,
  completedAt: ProjectionThreadCommandExecutionSummary.fields.completedAt,
  updatedAt: ProjectionThreadCommandExecutionSummary.fields.updatedAt,
  startedSequence: ProjectionThreadCommandExecutionSummary.fields.startedSequence,
  lastUpdatedSequence: ProjectionThreadCommandExecutionSummary.fields.lastUpdatedSequence,
});
type ProjectionThreadCommandExecutionSummaryDbRow =
  typeof ProjectionThreadCommandExecutionSummaryDbRowSchema.Type;

function fromDbRow(row: ProjectionThreadCommandExecutionDbRow): ProjectionThreadCommandExecution {
  const { cwd, ...rest } = row;
  return {
    ...rest,
    ...(cwd !== null ? { cwd } : {}),
    outputTruncated: row.outputTruncated === 1,
  };
}

function fromSummaryDbRow(
  row: ProjectionThreadCommandExecutionSummaryDbRow,
): ProjectionThreadCommandExecutionSummary {
  const { cwd, ...rest } = row;
  return {
    ...rest,
    ...(cwd !== null ? { cwd } : {}),
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadCommandExecutionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadCommandExecution = SqlSchema.void({
    Request: ProjectionThreadCommandExecution,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_command_executions (
          command_execution_id,
          thread_id,
          turn_id,
          provider_item_id,
          command,
          cwd,
          title,
          status,
          detail,
          output,
          output_truncated,
          exit_code,
          started_sequence,
          last_updated_sequence,
          started_at,
          completed_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.threadId},
          ${row.turnId},
          ${row.providerItemId},
          ${row.command},
          ${row.cwd ?? null},
          ${row.title},
          ${row.status},
          ${row.detail},
          ${row.output},
          ${row.outputTruncated ? 1 : 0},
          ${row.exitCode},
          ${row.startedSequence},
          ${row.lastUpdatedSequence},
          ${row.startedAt},
          ${row.completedAt},
          ${row.updatedAt}
        )
        ON CONFLICT (command_execution_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          provider_item_id = excluded.provider_item_id,
          command = excluded.command,
          cwd = excluded.cwd,
          title = excluded.title,
          status = excluded.status,
          detail = excluded.detail,
          output = excluded.output,
          output_truncated = excluded.output_truncated,
          exit_code = excluded.exit_code,
          started_sequence = excluded.started_sequence,
          last_updated_sequence = excluded.last_updated_sequence,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadCommandExecutionById = SqlSchema.findOneOption({
    Request: GetProjectionThreadCommandExecutionByIdInput,
    Result: ProjectionThreadCommandExecutionDbRowSchema,
    execute: ({ commandExecutionId }) =>
      sql`
        SELECT
          command_execution_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          command,
          cwd,
          title,
          status,
          detail,
          output,
          output_truncated AS "outputTruncated",
          exit_code AS "exitCode",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt"
        FROM projection_thread_command_executions
        WHERE command_execution_id = ${commandExecutionId}
        LIMIT 1
      `,
  });

  const listProjectionThreadCommandExecutionsByThread = SqlSchema.findAll({
    Request: ListProjectionThreadCommandExecutionsByThreadInput,
    Result: ProjectionThreadCommandExecutionSummaryDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          command_execution_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          command,
          cwd,
          title,
          status,
          detail,
          exit_code AS "exitCode",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt"
        FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
        ORDER BY started_at ASC, started_sequence ASC, command_execution_id ASC
      `,
  });

  const listProjectionThreadCommandExecutionsByThreadAfterSequence = SqlSchema.findAll({
    Request: ListProjectionThreadCommandExecutionsByThreadAfterSequenceInput,
    Result: ProjectionThreadCommandExecutionSummaryDbRowSchema,
    execute: ({ threadId, afterSequenceExclusive }) =>
      sql`
        SELECT
          command_execution_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          command,
          cwd,
          title,
          status,
          detail,
          exit_code AS "exitCode",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt"
        FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
          AND last_updated_sequence > ${afterSequenceExclusive}
        ORDER BY started_at ASC, started_sequence ASC, command_execution_id ASC
      `,
  });

  const getProjectionThreadCommandExecutionsLatestSequence = SqlSchema.findOne({
    Request: GetProjectionThreadCommandExecutionsLatestSequenceInput,
    Result: Schema.Struct({ latestSequence: Schema.Int }),
    execute: ({ threadId }) =>
      sql`
        SELECT
          COALESCE(MAX(last_updated_sequence), 0) AS "latestSequence"
        FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadCommandExecutionsByThread = SqlSchema.void({
    Request: DeleteProjectionThreadCommandExecutionsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_command_executions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadCommandExecutionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadCommandExecution(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadCommandExecutionRepository.upsert:query",
          "ProjectionThreadCommandExecutionRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getById: ProjectionThreadCommandExecutionRepositoryShape["getById"] = (input) =>
    getProjectionThreadCommandExecutionById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadCommandExecutionRepository.getById:query",
          "ProjectionThreadCommandExecutionRepository.getById:decodeRow",
        ),
      ),
      Effect.map((result) =>
        Option.match(result, {
          onNone: () => null,
          onSome: (row) => fromDbRow(row),
        }),
      ),
    );

  const listByThreadId: ProjectionThreadCommandExecutionRepositoryShape["listByThreadId"] = (
    input,
  ) =>
    listProjectionThreadCommandExecutionsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadCommandExecutionRepository.listByThreadId:query",
          "ProjectionThreadCommandExecutionRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(fromSummaryDbRow)),
    );

  const listByThreadIdAfterSequence: ProjectionThreadCommandExecutionRepositoryShape["listByThreadIdAfterSequence"] =
    (input) =>
      listProjectionThreadCommandExecutionsByThreadAfterSequence(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadCommandExecutionRepository.listByThreadIdAfterSequence:query",
            "ProjectionThreadCommandExecutionRepository.listByThreadIdAfterSequence:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map(fromSummaryDbRow)),
      );

  const getLatestSequenceByThreadId: ProjectionThreadCommandExecutionRepositoryShape["getLatestSequenceByThreadId"] =
    (input) =>
      getProjectionThreadCommandExecutionsLatestSequence(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadCommandExecutionRepository.getLatestSequenceByThreadId:query",
            "ProjectionThreadCommandExecutionRepository.getLatestSequenceByThreadId:decodeRow",
          ),
        ),
        Effect.map((row) => row.latestSequence),
      );

  const deleteByThreadId: ProjectionThreadCommandExecutionRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadCommandExecutionsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadCommandExecutionRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByThreadIdAndTurnIds: ProjectionThreadCommandExecutionRepositoryShape["deleteByThreadIdAndTurnIds"] =
    (input) => {
      if (input.turnIds.length === 0) {
        return Effect.void;
      }
      return sql
        .withTransaction(
          Effect.forEach(
            input.turnIds,
            (turnId) =>
              sql`
                DELETE FROM projection_thread_command_executions
                WHERE thread_id = ${input.threadId}
                  AND turn_id = ${turnId}
              `,
            { concurrency: 1 },
          ).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError(
              "ProjectionThreadCommandExecutionRepository.deleteByThreadIdAndTurnIds:query",
            ),
          ),
        );
    };

  return {
    upsert,
    getById,
    listByThreadId,
    listByThreadIdAfterSequence,
    getLatestSequenceByThreadId,
    deleteByThreadId,
    deleteByThreadIdAndTurnIds,
  } satisfies ProjectionThreadCommandExecutionRepositoryShape;
});

export const ProjectionThreadCommandExecutionRepositoryLive = Layer.effect(
  ProjectionThreadCommandExecutionRepository,
  makeProjectionThreadCommandExecutionRepository,
);
