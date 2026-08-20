import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionWorkspaceQuery } from "../Services/ProjectionWorkspaceQuery.ts";
import { ProjectionWorkspaceQueryLive } from "./ProjectionWorkspaceQuery.ts";

const layer = it.layer(
  ProjectionWorkspaceQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorkspaceQuery", (it) => {
  it.effect("resolves project roots and thread worktree overrides without a full snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionWorkspaceQuery;

      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES
          (
            'project-live', 'Live', '/workspace/live', NULL, '[]',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          ),
          (
            'project-deleted', 'Deleted', '/workspace/deleted', NULL, '[]',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:01.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, tasks_json, tasks_turn_id,
          tasks_updated_at, compaction_json, session_notes_json,
          thread_references_json, archived_at, created_at, last_interaction_at,
          updated_at, deleted_at
        ) VALUES
          (
            'thread-project-root', 'project-live', 'Project root', 'gpt-5',
            'full-access', 'default', NULL, NULL, NULL, '[]', NULL, NULL, NULL,
            NULL, '[]', NULL, '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          ),
          (
            'thread-worktree', 'project-live', 'Worktree', 'gpt-5',
            'full-access', 'default', NULL, '/workspace/worktree', NULL, '[]',
            NULL, NULL, NULL, NULL, '[]', NULL, '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          ),
          (
            'thread-deleted-project', 'project-deleted', 'Deleted project', 'gpt-5',
            'full-access', 'default', NULL, NULL, NULL, '[]', NULL, NULL, NULL,
            NULL, '[]', NULL, '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          ),
          (
            'thread-deleted-project-worktree', 'project-deleted', 'Deleted worktree', 'gpt-5',
            'full-access', 'default', NULL, '/workspace/deleted-worktree', NULL, '[]',
            NULL, NULL, NULL, NULL, '[]', NULL, '2026-08-20T00:00:00.000Z',
            '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', NULL
          )
      `;

      const project = yield* query.getProjectWorkspace(ProjectId.makeUnsafe("project-live"));
      const projectThread = yield* query.getThreadWorkspace(
        ThreadId.makeUnsafe("thread-project-root"),
      );
      const worktreeThread = yield* query.getThreadWorkspace(
        ThreadId.makeUnsafe("thread-worktree"),
      );
      const deletedProject = yield* query.getProjectWorkspace(
        ProjectId.makeUnsafe("project-deleted"),
      );
      const deletedProjectThread = yield* query.getThreadWorkspace(
        ThreadId.makeUnsafe("thread-deleted-project"),
      );
      const deletedProjectWorktree = yield* query.getThreadWorkspace(
        ThreadId.makeUnsafe("thread-deleted-project-worktree"),
      );
      const deletedProjectThreadOwner = yield* query.getThreadProjectId(
        ThreadId.makeUnsafe("thread-deleted-project"),
      );

      assert.deepEqual(Option.getOrNull(project), {
        projectId: ProjectId.makeUnsafe("project-live"),
        workspaceRoot: "/workspace/live",
      });
      assert.equal(Option.getOrNull(projectThread)?.workspaceRoot, "/workspace/live");
      assert.equal(Option.getOrNull(worktreeThread)?.workspaceRoot, "/workspace/worktree");
      assert.isTrue(Option.isNone(deletedProject));
      assert.isTrue(Option.isNone(deletedProjectThread));
      assert.isTrue(Option.isNone(deletedProjectWorktree));
      assert.deepEqual(
        Option.getOrNull(deletedProjectThreadOwner),
        ProjectId.makeUnsafe("project-deleted"),
      );
    }),
  );
});
