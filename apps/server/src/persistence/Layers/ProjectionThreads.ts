import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";
import { ThreadCompaction, ThreadReference, ThreadSessionNotes } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    tasks: Schema.fromJsonString(ProjectionThread.fields.tasks),
    compaction: Schema.NullOr(Schema.fromJsonString(ThreadCompaction)),
    sessionNotes: Schema.NullOr(Schema.fromJsonString(ThreadSessionNotes)),
    threadReferences: Schema.fromJsonString(Schema.Array(ThreadReference)),
  }),
);

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          tasks_json,
          tasks_turn_id,
          tasks_updated_at,
          compaction_json,
          estimated_context_tokens,
          model_context_window_tokens,
          session_notes_json,
          thread_references_json,
          archived_at,
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.model},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.latestTurnId},
          ${JSON.stringify(row.tasks)},
          ${row.tasksTurnId},
          ${row.tasksUpdatedAt},
          ${row.compaction === null ? null : JSON.stringify(row.compaction)},
          ${row.estimatedContextTokens},
          ${row.modelContextWindowTokens},
          ${row.sessionNotes === null ? null : JSON.stringify(row.sessionNotes)},
          ${JSON.stringify(row.threadReferences)},
          ${row.archivedAt},
          ${row.createdAt},
          ${row.lastInteractionAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model = excluded.model,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          tasks_json = excluded.tasks_json,
          tasks_turn_id = excluded.tasks_turn_id,
          tasks_updated_at = excluded.tasks_updated_at,
          compaction_json = excluded.compaction_json,
          estimated_context_tokens = excluded.estimated_context_tokens,
          model_context_window_tokens = excluded.model_context_window_tokens,
          session_notes_json = excluded.session_notes_json,
          thread_references_json = excluded.thread_references_json,
          archived_at = excluded.archived_at,
          created_at = excluded.created_at,
          last_interaction_at = excluded.last_interaction_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          tasks_json AS "tasks",
          tasks_turn_id AS "tasksTurnId",
          tasks_updated_at AS "tasksUpdatedAt",
          compaction_json AS "compaction",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens",
          session_notes_json AS "sessionNotes",
          thread_references_json AS "threadReferences",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          last_interaction_at AS "lastInteractionAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          tasks_json AS "tasks",
          tasks_turn_id AS "tasksTurnId",
          tasks_updated_at AS "tasksUpdatedAt",
          compaction_json AS "compaction",
          estimated_context_tokens AS "estimatedContextTokens",
          model_context_window_tokens AS "modelContextWindowTokens",
          session_notes_json AS "sessionNotes",
          thread_references_json AS "threadReferences",
          archived_at AS "archivedAt",
          created_at AS "createdAt",
          last_interaction_at AS "lastInteractionAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY last_interaction_at DESC, created_at DESC, thread_id DESC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
