import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  CodeReviewTargetSnapshot,
  CodeReviewTargetSnapshotRepository,
  type CodeReviewTargetSnapshotRepositoryShape,
} from "../Services/CodeReviewTargetSnapshots.ts";

const SnapshotRow = Schema.Struct({
  snapshot: Schema.fromJsonString(CodeReviewTargetSnapshot),
});

const UpsertRequest = Schema.Struct({
  workflowId: Schema.String,
  snapshotId: Schema.String,
  projectId: Schema.String,
  snapshot: Schema.fromJsonString(CodeReviewTargetSnapshot),
  createdAt: Schema.String,
});

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeCodeReviewTargetSnapshotRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertRequest,
    execute: (row) => sql`
      INSERT INTO code_review_target_snapshots (
        workflow_id,
        snapshot_id,
        project_id,
        snapshot_json,
        created_at
      )
      VALUES (
        ${row.workflowId},
        ${row.snapshotId},
        ${row.projectId},
        ${row.snapshot},
        ${row.createdAt}
      )
      ON CONFLICT (workflow_id)
      DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        project_id = excluded.project_id,
        snapshot_json = excluded.snapshot_json,
        created_at = excluded.created_at
    `,
  });

  const getByWorkflowRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SnapshotRow,
    execute: (workflowId) => sql`
      SELECT snapshot_json AS "snapshot"
      FROM code_review_target_snapshots
      WHERE workflow_id = ${workflowId}
    `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SnapshotRow,
    execute: (snapshotId) => sql`
      SELECT snapshot_json AS "snapshot"
      FROM code_review_target_snapshots
      WHERE snapshot_id = ${snapshotId}
    `,
  });

  const upsert: CodeReviewTargetSnapshotRepositoryShape["upsert"] = (snapshot) =>
    upsertRow({
      workflowId: snapshot.workflowId,
      snapshotId: snapshot.id,
      projectId: snapshot.projectId,
      snapshot,
      createdAt: snapshot.capturedAt,
    }).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "CodeReviewTargetSnapshotRepository.upsert:query",
          "CodeReviewTargetSnapshotRepository.upsert:encode",
        ),
      ),
    );

  const getByWorkflowId: CodeReviewTargetSnapshotRepositoryShape["getByWorkflowId"] = (
    workflowId,
  ) =>
    getByWorkflowRow(workflowId).pipe(
      Effect.map(Option.map((row) => row.snapshot)),
      Effect.mapError(
        toSqlOrDecodeError(
          "CodeReviewTargetSnapshotRepository.getByWorkflowId:query",
          "CodeReviewTargetSnapshotRepository.getByWorkflowId:decodeRow",
        ),
      ),
    );

  const getById: CodeReviewTargetSnapshotRepositoryShape["getById"] = (snapshotId) =>
    getByIdRow(snapshotId).pipe(
      Effect.map(Option.map((row) => row.snapshot)),
      Effect.mapError(
        toSqlOrDecodeError(
          "CodeReviewTargetSnapshotRepository.getById:query",
          "CodeReviewTargetSnapshotRepository.getById:decodeRow",
        ),
      ),
    );

  return { upsert, getByWorkflowId, getById } satisfies CodeReviewTargetSnapshotRepositoryShape;
});

export const CodeReviewTargetSnapshotRepositoryLive = Layer.effect(
  CodeReviewTargetSnapshotRepository,
  makeCodeReviewTargetSnapshotRepository,
);
