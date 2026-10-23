import {
  MAX_AGENTS_SNAPSHOT_ENTRIES,
  ThreadBackgroundWorkEntry,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DismissThreadBackgroundWorkInput,
  ExpireThreadBackgroundWorkInput,
  ListThreadBackgroundWorkSnapshotInput,
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

  // Progress is a heartbeat, not a task start. Unknown or completed tasks must
  // not become active merely because delayed progress arrives.
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
        kind,
        status,
        active,
        model,
        effort,
        phase,
        title,
        prompt,
        last_tool,
        latest_output,
        output_truncated,
        started_at,
        updated_at,
        last_seen_at,
        completed_at
      ) SELECT
        ${row.threadId},
        ${row.workItemId},
        ${row.provider},
        ${row.providerInstanceId},
        ${row.providerSessionIdentity},
        ${row.turnId},
        ${row.classification ?? "working"},
        ${row.ownership ?? "direct-subagent"},
        ${row.kind ?? "agent"},
        ${row.status},
        ${row.active ? 1 : 0},
        ${row.model ?? null},
        ${row.effort ?? null},
        ${row.phase ?? null},
        ${row.title ?? null},
        ${row.prompt ?? null},
        ${row.lastTool ?? null},
        ${row.latestOutput ?? null},
        ${row.outputTruncated === true ? 1 : 0},
        ${row.occurredAt},
        ${row.occurredAt},
        ${row.occurredAt},
        ${row.active ? null : row.occurredAt}
      WHERE ${row.progressOnly ? 1 : 0} = 0 OR EXISTS (
        SELECT 1 FROM projection_thread_background_work
        WHERE thread_id = ${row.threadId} AND provider_work_item_id = ${row.workItemId}
          AND provider_session_identity IS ${row.providerSessionIdentity} AND active = 1
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
        kind = CASE
          WHEN ${row.kind ?? null} IS NULL
            THEN projection_thread_background_work.kind
          ELSE excluded.kind
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
        effort = CASE
          WHEN ${row.effort === undefined ? 1 : 0} = 1
            THEN CASE WHEN ${row.model === undefined ? 1 : 0} = 0 AND excluded.model IS NOT projection_thread_background_work.model
              THEN NULL ELSE projection_thread_background_work.effort END
          ELSE excluded.effort
        END,
        phase = CASE
          WHEN ${row.phase === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.phase
          ELSE excluded.phase
        END,
        -- Identity is written once: the first non-null title and prompt win.
        title = COALESCE(projection_thread_background_work.title, excluded.title),
        prompt = COALESCE(projection_thread_background_work.prompt, excluded.prompt),
        last_tool = CASE
          WHEN ${row.lastTool === undefined ? 1 : 0} = 1
            THEN projection_thread_background_work.last_tool
          ELSE excluded.last_tool
        END,
        dismissed_at = CASE
          WHEN excluded.active = 1 AND projection_thread_background_work.classification <> 'inert'
            THEN NULL
          ELSE projection_thread_background_work.dismissed_at
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
          WHEN projection_thread_background_work.active = 0 AND excluded.active = 0
            AND projection_thread_background_work.status = excluded.status
            AND excluded.status IN ('completed', 'failed', 'stopped', 'interrupted')
            AND projection_thread_background_work.provider_session_identity IS excluded.provider_session_identity
            THEN COALESCE(projection_thread_background_work.completed_at, excluded.completed_at)
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
    Request: ListThreadBackgroundWorkSnapshotInput,
    Result: ThreadBackgroundWorkDbRow,
    execute: ({ threadId }) => {
      // Global snapshots are pushed to every client on each change, so they
      // leave out the prompt; thread-scoped reads carry it for the detail view.
      // Separate statements keep the thread filter usable by the visibility index.
      const prompt = threadId === undefined ? sql`NULL` : sql`prompt`;
      const threadFilter = threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`;
      return sql`
        SELECT
          thread_id AS "threadId",
          provider_work_item_id AS "workItemId",
          provider_name AS provider,
          provider_instance_id AS "providerInstanceId",
          provider_session_identity AS "providerSessionIdentity",
          turn_id AS "turnId",
          classification,
          ownership,
          kind,
          status,
          active,
          model,
          effort,
          phase,
          title,
          ${prompt} AS prompt,
          last_tool AS "lastTool",
          latest_output AS "latestOutput",
          output_truncated AS "outputTruncated",
          started_at AS "startedAt",
          updated_at AS "updatedAt",
          last_seen_at AS "lastSeenAt",
          completed_at AS "completedAt"
        FROM projection_thread_background_work
        WHERE dismissed_at IS NULL ${threadFilter}
        ORDER BY active DESC, updated_at DESC, thread_id ASC, provider_work_item_id ASC
        LIMIT ${MAX_AGENTS_SNAPSHOT_ENTRIES}
      `;
    },
  });

  const dismissQuery = SqlSchema.findAll({
    Request: DismissThreadBackgroundWorkInput,
    Result: Schema.Struct({ workItemId: TrimmedNonEmptyString }),
    execute: ({ threadId, workItemIds, dismissedAt }) => {
      const threadFilter = threadId === undefined ? sql`1 = 1` : sql`thread_id = ${threadId}`;
      const itemFilter =
        workItemIds === undefined
          ? sql`1 = 1`
          : sql`provider_work_item_id IN ${sql.in(workItemIds)}`;
      return sql`
        UPDATE projection_thread_background_work
        SET dismissed_at = ${dismissedAt}
        WHERE active = 0
          AND dismissed_at IS NULL
          AND ${threadFilter}
          AND ${itemFilter}
        RETURNING provider_work_item_id AS "workItemId"
      `;
    },
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

  const dismiss: ThreadBackgroundWorkRepositoryShape["dismiss"] = (input) =>
    (input.workItemIds !== undefined && input.workItemIds.length === 0
      ? Effect.succeed([])
      : dismissQuery(input)
    ).pipe(
      Effect.mapError(toPersistenceSqlError("ThreadBackgroundWorkRepository.dismiss")),
      Effect.map((rows) => rows.length),
    );

  const listSnapshot: ThreadBackgroundWorkRepositoryShape["listSnapshot"] = (input = {}) =>
    listSnapshotQuery(input).pipe(
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
    dismiss,
    listProtectedThreadIds,
    hasFreshProtectingWork,
    prune,
  } satisfies ThreadBackgroundWorkRepositoryShape;
});

export const ThreadBackgroundWorkRepositoryLive = Layer.effect(
  ThreadBackgroundWorkRepository,
  make,
);
