import { MAX_AGENTS_SNAPSHOT_ENTRIES, ThreadBackgroundWorkEntry } from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ExpireThreadBackgroundWorkInput,
  MarkThreadBackgroundWorkInactiveInput,
  ThreadBackgroundWorkFreshnessInput,
  ThreadBackgroundWorkRepository,
  ThreadBackgroundWorkThreadFreshnessInput,
  ThreadBackgroundWorkTransition,
  type ThreadBackgroundWorkRepositoryShape,
} from "../Services/ThreadBackgroundWork.ts";

const MAX_BACKGROUND_WORK_ROWS_PER_THREAD = 200;
const MAX_BACKGROUND_WORK_ROWS_TOTAL = 10_000;

const ThreadBackgroundWorkDbRow = ThreadBackgroundWorkEntry.mapFields(
  Struct.assign({
    active: Schema.Literals([0, 1]),
    outputTruncated: Schema.Literals([0, 1]),
  }),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertQuery = SqlSchema.void({
    Request: ThreadBackgroundWorkTransition,
    execute: (row) => sql`
      INSERT INTO projection_thread_background_work (
        thread_id,
        provider_work_item_id,
        provider_name,
        provider_instance_id,
        provider_session_identity,
        turn_id,
        classification,
        ownership,
        status,
        active,
        model,
        phase,
        latest_output,
        output_truncated,
        started_at,
        updated_at,
        last_seen_at,
        completed_at
      ) VALUES (
        ${row.threadId},
        ${row.workItemId},
        ${row.provider},
        ${row.providerInstanceId},
        ${row.providerSessionIdentity},
        ${row.turnId},
        ${row.classification ?? "working"},
        ${row.ownership ?? "direct-subagent"},
        ${row.status},
        ${row.active ? 1 : 0},
        ${row.model ?? null},
        ${row.phase ?? null},
        ${row.latestOutput ?? null},
        ${row.outputTruncated === true ? 1 : 0},
        ${row.occurredAt},
        ${row.occurredAt},
        ${row.occurredAt},
        ${row.active ? null : row.occurredAt}
      )
      ON CONFLICT (thread_id, provider_work_item_id)
      DO UPDATE SET
        provider_name = excluded.provider_name,
        provider_instance_id = excluded.provider_instance_id,
        provider_session_identity = excluded.provider_session_identity,
        turn_id = COALESCE(excluded.turn_id, projection_thread_background_work.turn_id),
        classification = CASE
          WHEN ${row.classification ?? null} IS NULL
            THEN projection_thread_background_work.classification
          ELSE excluded.classification
        END,
        ownership = CASE
          WHEN ${row.ownership ?? null} IS NULL
            THEN projection_thread_background_work.ownership
          ELSE excluded.ownership
        END,
        status = CASE
          WHEN projection_thread_background_work.classification = 'inert' AND excluded.active = 1
            THEN 'idle'
          ELSE excluded.status
        END,
        active = CASE
          WHEN projection_thread_background_work.classification = 'inert' THEN 0
          ELSE excluded.active
        END,
        model = CASE
          WHEN ${row.model === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.model
          ELSE excluded.model
        END,
        phase = CASE
          WHEN ${row.phase === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.phase
          ELSE excluded.phase
        END,
        latest_output = CASE
          WHEN ${row.latestOutput === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.latest_output
          ELSE excluded.latest_output
        END,
        output_truncated = CASE
          WHEN ${row.outputTruncated === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.output_truncated
          ELSE excluded.output_truncated
        END,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at,
        completed_at = CASE
          WHEN projection_thread_background_work.classification = 'inert' AND excluded.active = 1
            THEN projection_thread_background_work.completed_at
          ELSE excluded.completed_at
        END
      WHERE
        excluded.updated_at > projection_thread_background_work.updated_at
        OR (
          excluded.updated_at = projection_thread_background_work.updated_at
          AND (
            projection_thread_background_work.active = 1
            OR excluded.active = 0
          )
        )
    `,
  });

  const markThreadInactiveQuery = SqlSchema.void({
    Request: MarkThreadBackgroundWorkInactiveInput,
    execute: ({ threadId, completedAt }) => sql`
      UPDATE projection_thread_background_work
      SET
        active = 0,
        status = 'stopped',
        updated_at = ${completedAt},
        last_seen_at = ${completedAt},
        completed_at = ${completedAt}
      WHERE thread_id = ${threadId} AND active = 1 AND updated_at <= ${completedAt}
    `,
  });

  const expireStaleQuery = SqlSchema.void({
    Request: ExpireThreadBackgroundWorkInput,
    execute: ({ freshSince, expiredAt }) => sql`
      UPDATE projection_thread_background_work
      SET
        active = 0,
        status = 'stopped',
        updated_at = ${expiredAt},
        completed_at = ${expiredAt}
      WHERE active = 1 AND last_seen_at < ${freshSince}
    `,
  });

  const listSnapshotQuery = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: ThreadBackgroundWorkDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        provider_work_item_id AS "workItemId",
        provider_name AS provider,
        provider_instance_id AS "providerInstanceId",
        provider_session_identity AS "providerSessionIdentity",
        turn_id AS "turnId",
        classification,
        ownership,
        status,
        active,
        model,
        phase,
        latest_output AS "latestOutput",
        output_truncated AS "outputTruncated",
        started_at AS "startedAt",
        updated_at AS "updatedAt",
        last_seen_at AS "lastSeenAt",
        completed_at AS "completedAt"
      FROM projection_thread_background_work
      ORDER BY active DESC, updated_at DESC, thread_id ASC, provider_work_item_id ASC
      LIMIT ${MAX_AGENTS_SNAPSHOT_ENTRIES}
    `,
  });

  const listProtectedThreadIdsQuery = SqlSchema.findAll({
    Request: ThreadBackgroundWorkFreshnessInput,
    Result: Schema.Struct({ threadId: ThreadBackgroundWorkEntry.fields.threadId }),
    execute: ({ freshSince }) => sql`
      SELECT DISTINCT thread_id AS "threadId"
      FROM projection_thread_background_work
      WHERE
        active = 1
        AND classification IN ('working', 'monitoring')
        AND last_seen_at >= ${freshSince}
    `,
  });

  const hasFreshProtectingWorkQuery = SqlSchema.findAll({
    Request: ThreadBackgroundWorkThreadFreshnessInput,
    Result: Schema.Struct({ found: Schema.Literals([0, 1]) }),
    execute: ({ threadId, freshSince }) => sql`
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM projection_thread_background_work
        WHERE
          thread_id = ${threadId}
          AND active = 1
          AND classification IN ('working', 'monitoring')
          AND last_seen_at >= ${freshSince}
      ) THEN 1 ELSE 0 END AS found
    `,
  });

  const prune = () =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM projection_thread_background_work
        WHERE rowid IN (
          SELECT rowid
          FROM (
            SELECT
              rowid,
              ROW_NUMBER() OVER (
                PARTITION BY thread_id
                ORDER BY active DESC, updated_at DESC, provider_work_item_id ASC
              ) AS row_number
            FROM projection_thread_background_work
          )
          WHERE row_number > ${MAX_BACKGROUND_WORK_ROWS_PER_THREAD}
        )
      `;
      yield* sql`
        DELETE FROM projection_thread_background_work
        WHERE rowid IN (
          SELECT rowid
          FROM projection_thread_background_work
          ORDER BY active DESC, updated_at DESC, thread_id ASC, provider_work_item_id ASC
          LIMIT -1 OFFSET ${MAX_BACKGROUND_WORK_ROWS_TOTAL}
        )
      `;
    }).pipe(Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.prune")));

  const upsertTransition: ThreadBackgroundWorkRepositoryShape["upsertTransition"] = (row) =>
    upsertQuery(row).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.upsertTransition")),
    );

  const markThreadInactive: ThreadBackgroundWorkRepositoryShape["markThreadInactive"] = (input) =>
    markThreadInactiveQuery(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.markThreadInactive")),
    );

  const expireStale: ThreadBackgroundWorkRepositoryShape["expireStale"] = (input) =>
    expireStaleQuery(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.expireStale")),
    );

  const listSnapshot: ThreadBackgroundWorkRepositoryShape["listSnapshot"] = () =>
    listSnapshotQuery({}).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("ThreadBackgroundWorkRepository.listSnapshot")(cause)
          : toPersistenceSqlError("ThreadBackgroundWorkRepository.listSnapshot")(cause),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          ...row,
          active: row.active === 1,
          outputTruncated: row.outputTruncated === 1,
        })),
      ),
    );

  const listProtectedThreadIds: ThreadBackgroundWorkRepositoryShape["listProtectedThreadIds"] = (
    input,
  ) =>
    listProtectedThreadIdsQuery(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.listProtected")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const hasFreshProtectingWork: ThreadBackgroundWorkRepositoryShape["hasFreshProtectingWork"] = (
    input,
  ) =>
    hasFreshProtectingWorkQuery(input).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.hasFreshLiveness")),
      Effect.map((result) => result[0]?.found === 1),
    );

  return {
    upsertTransition,
    markThreadInactive,
    expireStale,
    listSnapshot,
    listProtectedThreadIds,
    hasFreshProtectingWork,
    prune,
  } satisfies ThreadBackgroundWorkRepositoryShape;
});

export const ThreadBackgroundWorkRepositoryLive = Layer.effect(
  ThreadBackgroundWorkRepository,
  make,
);
