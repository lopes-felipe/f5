import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadFileChangesByThreadInput,
  GetProjectionThreadFileChangeByIdInput,
  GetProjectionThreadFileChangesLatestSequenceInput,
  ListProjectionThreadFileChangesByThreadAfterSequenceInput,
  ListProjectionThreadFileChangesByThreadInput,
  ProjectionThreadFileChange,
  ProjectionThreadFileChangeRepository,
  ProjectionThreadFileChangeSummary,
  type ProjectionThreadFileChangeRepositoryShape,
} from "../Services/ProjectionThreadFileChanges.ts";

const ProjectionThreadFileChangeSummaryDbRowSchema = Schema.Struct({
  id: ProjectionThreadFileChangeSummary.fields.id,
  threadId: ProjectionThreadFileChangeSummary.fields.threadId,
  turnId: ProjectionThreadFileChangeSummary.fields.turnId,
  providerItemId: ProjectionThreadFileChangeSummary.fields.providerItemId,
  title: ProjectionThreadFileChangeSummary.fields.title,
  detail: ProjectionThreadFileChangeSummary.fields.detail,
  status: ProjectionThreadFileChangeSummary.fields.status,
  changedFiles: Schema.String,
  startedAt: ProjectionThreadFileChangeSummary.fields.startedAt,
  completedAt: ProjectionThreadFileChangeSummary.fields.completedAt,
  updatedAt: ProjectionThreadFileChangeSummary.fields.updatedAt,
  startedSequence: ProjectionThreadFileChangeSummary.fields.startedSequence,
  lastUpdatedSequence: ProjectionThreadFileChangeSummary.fields.lastUpdatedSequence,
  hasPatch: Schema.Int,
});
type ProjectionThreadFileChangeSummaryDbRow =
  typeof ProjectionThreadFileChangeSummaryDbRowSchema.Type;

const ProjectionThreadFileChangeDbRowSchema = Schema.Struct({
  id: ProjectionThreadFileChange.fields.id,
  threadId: ProjectionThreadFileChange.fields.threadId,
  turnId: ProjectionThreadFileChange.fields.turnId,
  providerItemId: ProjectionThreadFileChange.fields.providerItemId,
  title: ProjectionThreadFileChange.fields.title,
  detail: ProjectionThreadFileChange.fields.detail,
  status: ProjectionThreadFileChange.fields.status,
  changedFiles: Schema.String,
  startedAt: ProjectionThreadFileChange.fields.startedAt,
  completedAt: ProjectionThreadFileChange.fields.completedAt,
  updatedAt: ProjectionThreadFileChange.fields.updatedAt,
  startedSequence: ProjectionThreadFileChange.fields.startedSequence,
  lastUpdatedSequence: ProjectionThreadFileChange.fields.lastUpdatedSequence,
  hasPatch: Schema.Int,
  patch: ProjectionThreadFileChange.fields.patch,
});
type ProjectionThreadFileChangeDbRow = typeof ProjectionThreadFileChangeDbRowSchema.Type;

const decodeChangedFiles = Schema.decodeUnknownSync(ProjectionThreadFileChange.fields.changedFiles);

function fromSummaryDbRow(
  row: ProjectionThreadFileChangeSummaryDbRow,
): ProjectionThreadFileChangeSummary {
  return {
    ...row,
    changedFiles: decodeChangedFiles(JSON.parse(row.changedFiles)),
    hasPatch: row.hasPatch === 1,
  };
}

function fromDbRow(row: ProjectionThreadFileChangeDbRow): ProjectionThreadFileChange {
  return {
    ...row,
    changedFiles: decodeChangedFiles(JSON.parse(row.changedFiles)),
    hasPatch: row.hasPatch === 1,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadFileChangeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadFileChange = SqlSchema.void({
    Request: ProjectionThreadFileChange,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_file_changes (
          file_change_id,
          thread_id,
          turn_id,
          provider_item_id,
          title,
          detail,
          status,
          changed_files,
          patch,
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
          ${row.title},
          ${row.detail},
          ${row.status},
          ${JSON.stringify(row.changedFiles)},
          ${row.patch},
          ${row.startedSequence},
          ${row.lastUpdatedSequence},
          ${row.startedAt},
          ${row.completedAt},
          ${row.updatedAt}
        )
        ON CONFLICT (file_change_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          provider_item_id = excluded.provider_item_id,
          title = excluded.title,
          detail = excluded.detail,
          status = excluded.status,
          changed_files = excluded.changed_files,
          patch = excluded.patch,
          started_sequence = excluded.started_sequence,
          last_updated_sequence = excluded.last_updated_sequence,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadFileChangeById = SqlSchema.findOneOption({
    Request: GetProjectionThreadFileChangeByIdInput,
    Result: ProjectionThreadFileChangeDbRowSchema,
    execute: ({ threadId, fileChangeId }) =>
      sql`
        SELECT
          file_change_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          title,
          detail,
          status,
          changed_files AS "changedFiles",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt",
          CASE WHEN length(patch) > 0 THEN 1 ELSE 0 END AS "hasPatch",
          patch
        FROM projection_thread_file_changes
        WHERE thread_id = ${threadId}
          AND file_change_id = ${fileChangeId}
        LIMIT 1
      `,
  });

  const listProjectionThreadFileChangesByThread = SqlSchema.findAll({
    Request: ListProjectionThreadFileChangesByThreadInput,
    Result: ProjectionThreadFileChangeSummaryDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          file_change_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          title,
          detail,
          status,
          changed_files AS "changedFiles",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt",
          CASE WHEN length(patch) > 0 THEN 1 ELSE 0 END AS "hasPatch"
        FROM projection_thread_file_changes
        WHERE thread_id = ${threadId}
        ORDER BY started_at ASC, started_sequence ASC, file_change_id ASC
      `,
  });

  const listProjectionThreadFileChangesByThreadAfterSequence = SqlSchema.findAll({
    Request: ListProjectionThreadFileChangesByThreadAfterSequenceInput,
    Result: ProjectionThreadFileChangeSummaryDbRowSchema,
    execute: ({ threadId, afterSequenceExclusive }) =>
      sql`
        SELECT
          file_change_id AS id,
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_item_id AS "providerItemId",
          title,
          detail,
          status,
          changed_files AS "changedFiles",
          started_sequence AS "startedSequence",
          last_updated_sequence AS "lastUpdatedSequence",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          updated_at AS "updatedAt",
          CASE WHEN length(patch) > 0 THEN 1 ELSE 0 END AS "hasPatch"
        FROM projection_thread_file_changes
        WHERE thread_id = ${threadId}
          AND last_updated_sequence > ${afterSequenceExclusive}
        ORDER BY started_at ASC, started_sequence ASC, file_change_id ASC
      `,
  });

  const getProjectionThreadFileChangesLatestSequence = SqlSchema.findOne({
    Request: GetProjectionThreadFileChangesLatestSequenceInput,
    Result: Schema.Struct({ latestSequence: Schema.Int }),
    execute: ({ threadId }) =>
      sql`
        SELECT
          COALESCE(MAX(last_updated_sequence), 0) AS "latestSequence"
        FROM projection_thread_file_changes
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadFileChangesByThread = SqlSchema.void({
    Request: DeleteProjectionThreadFileChangesByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_file_changes
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadFileChangeRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadFileChange(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadFileChangeRepository.upsert:query",
          "ProjectionThreadFileChangeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getById: ProjectionThreadFileChangeRepositoryShape["getById"] = (input) =>
    getProjectionThreadFileChangeById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadFileChangeRepository.getById:query",
          "ProjectionThreadFileChangeRepository.getById:decodeRow",
        ),
      ),
      Effect.map((result) =>
        Option.match(result, {
          onNone: () => null,
          onSome: fromDbRow,
        }),
      ),
    );

  const listByThreadId: ProjectionThreadFileChangeRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadFileChangesByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadFileChangeRepository.listByThreadId:query",
          "ProjectionThreadFileChangeRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(fromSummaryDbRow)),
    );

  const listByThreadIdAfterSequence: ProjectionThreadFileChangeRepositoryShape["listByThreadIdAfterSequence"] =
    (input) =>
      listProjectionThreadFileChangesByThreadAfterSequence(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadFileChangeRepository.listByThreadIdAfterSequence:query",
            "ProjectionThreadFileChangeRepository.listByThreadIdAfterSequence:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map(fromSummaryDbRow)),
      );

  const getLatestSequenceByThreadId: ProjectionThreadFileChangeRepositoryShape["getLatestSequenceByThreadId"] =
    (input) =>
      getProjectionThreadFileChangesLatestSequence(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadFileChangeRepository.getLatestSequenceByThreadId:query",
            "ProjectionThreadFileChangeRepository.getLatestSequenceByThreadId:decodeRow",
          ),
        ),
        Effect.map((row) => row.latestSequence),
      );

  const deleteByThreadId: ProjectionThreadFileChangeRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadFileChangesByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadFileChangeRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByThreadIdAndTurnIds: ProjectionThreadFileChangeRepositoryShape["deleteByThreadIdAndTurnIds"] =
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
                DELETE FROM projection_thread_file_changes
                WHERE thread_id = ${input.threadId}
                  AND turn_id = ${turnId}
              `,
            { concurrency: 1 },
          ).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.mapError(
            toPersistenceSqlError(
              "ProjectionThreadFileChangeRepository.deleteByThreadIdAndTurnIds:query",
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
  } satisfies ProjectionThreadFileChangeRepositoryShape;
});

export const ProjectionThreadFileChangeRepositoryLive = Layer.effect(
  ProjectionThreadFileChangeRepository,
  makeProjectionThreadFileChangeRepository,
);
