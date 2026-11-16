import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  THREAD_CONTEXT_ITEM_MAX_CHARS,
  THREAD_CONTEXT_PREVIEW_MAX_CHARS,
} from "../Services/ProjectionThreadMessages.ts";
import {
  DeleteProjectionThreadProposedPlansInput,
  GetProjectionThreadProposedPlanContextItemInput,
  ProjectionThreadProposedPlanContext,
  ListProjectionThreadProposedPlansInput,
  ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../Services/ProjectionThreadProposedPlans.ts";

const makeProjectionThreadProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProposedPlanRow = SqlSchema.void({
    Request: ProjectionThreadProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        plan_markdown,
        implemented_at,
        implementation_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationThreadId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_thread_id = excluded.implementation_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlan,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const getLatestContextRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ProjectionThreadProposedPlanContext,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        substr(plan_markdown, 1, ${THREAD_CONTEXT_PREVIEW_MAX_CHARS}) AS text,
        length(plan_markdown) AS "totalLength",
        implemented_at AS "implementedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, plan_id DESC
      LIMIT 1
    `,
  });

  const getContextItemRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadProposedPlanContextItemInput,
    Result: ProjectionThreadProposedPlanContext,
    execute: ({ threadId, planId, offset }) => sql`
      SELECT
        plan_id AS "planId",
        substr(plan_markdown, ${offset + 1}, ${THREAD_CONTEXT_ITEM_MAX_CHARS}) AS text,
        length(plan_markdown) AS "totalLength",
        implemented_at AS "implementedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE plan_id = ${planId} AND thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProposedPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadProposedPlanRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadProposedPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.listByThreadId:query"),
      ),
    );

  const getLatestContext: ProjectionThreadProposedPlanRepositoryShape["getLatestContext"] = (
    threadId,
  ) =>
    getLatestContextRow({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.getLatestContext:query"),
      ),
    );

  const getContextItem: ProjectionThreadProposedPlanRepositoryShape["getContextItem"] = (input) =>
    getContextItemRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.getContextItem:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadProposedPlanRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getLatestContext,
    getContextItem,
    deleteByThreadId,
  } satisfies ProjectionThreadProposedPlanRepositoryShape;
});

export const ProjectionThreadProposedPlanRepositoryLive = Layer.effect(
  ProjectionThreadProposedPlanRepository,
  makeProjectionThreadProposedPlanRepository,
);
