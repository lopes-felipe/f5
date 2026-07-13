import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeGlobalSearch } from "./globalSearch.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

const projectId = ProjectId.makeUnsafe("search-project");

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_planning_workflows WHERE project_id = ${projectId}`;
  yield* sql`
    DELETE FROM projection_thread_file_changes
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
  `;
  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
  `;
  yield* sql`
    DELETE FROM projection_thread_messages
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
  `;
  yield* sql`
    DELETE FROM projection_thread_sessions
    WHERE thread_id IN (SELECT thread_id FROM projection_threads WHERE project_id = ${projectId})
  `;
  yield* sql`DELETE FROM projection_threads WHERE project_id = ${projectId}`;
  yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model, scripts_json,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Search Project', '/tmp/search-project', 'gpt-5.1-codex', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model, runtime_mode, interaction_mode,
      branch, worktree_path, created_at, last_interaction_at, updated_at, deleted_at
    ) VALUES (
      'search-thread', ${projectId}, 'Durable reconnect work', 'gpt-5.1-codex',
      'approval-required', 'default', 'feature/reconnect', '/tmp/search-project',
      '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_sessions (
      thread_id, status, provider_name, provider_instance_id, runtime_mode, updated_at
    ) VALUES (
      'search-thread', 'ready', 'codex', 'codex-work', 'approval-required',
      '2026-01-03T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, reasoning_text,
      is_streaming, created_at, updated_at
    ) VALUES (
      'search-message', 'search-thread', 'search-turn', 'assistant',
      'Reconnect recovery now uses a durable snapshot.', 'hidden chain secret', 0,
      '2026-01-03T00:00:01.000Z', '2026-01-03T00:00:01.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    ) VALUES (
      'search-activity', 'search-thread', 'search-turn', 'info', 'status',
      'Validated snapshot recovery', '{"rawTerminalLog":"never index me"}', 1,
      '2026-01-03T00:00:02.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_thread_file_changes (
      file_change_id, thread_id, turn_id, status, changed_files, patch,
      started_sequence, last_updated_sequence, started_at, updated_at
    ) VALUES (
      'search-file-change', 'search-thread', 'search-turn', 'completed',
      '["apps/web/src/wsTransport.ts","apps/server/src/wsServer.ts"]', '',
      1, 2, '2026-01-03T00:00:03.000Z', '2026-01-03T00:00:03.000Z'
    )
  `;
  yield* sql`
    INSERT INTO projection_planning_workflows (
      workflow_id, project_id, workflow_json, updated_at, deleted_at
    ) VALUES (
      'search-workflow', ${projectId},
      '{"title":"Reconnect hardening plan","requirementPrompt":"Design bounded replay recovery","createdAt":"2026-01-04T00:00:00.000Z","deletedAt":null}',
      '2026-01-04T00:00:00.000Z', NULL
    )
  `;
});

layer("GlobalSearch", (it) => {
  it.effect("indexes visible messages, summaries, file paths, threads, and workflows", () =>
    Effect.gen(function* () {
      yield* seed;
      const search = yield* makeGlobalSearch;

      const messages = yield* search.query({ query: "durable snapshot" });
      assert.equal(messages.results[0]?.kind, "message");
      assert.equal(messages.results[0]?.messageId, "search-message");

      const files = yield* search.query({ query: "wsTransport" });
      assert.equal(files.results[0]?.kind, "fileChange");
      assert.equal(files.results[0]?.path, "apps/web/src/wsTransport.ts");

      const workflows = yield* search.query({ query: "bounded replay" });
      assert.equal(workflows.results[0]?.kind, "workflow.planning");
      assert.equal(workflows.results[0]?.workflowId, "search-workflow");

      const hiddenReasoning = yield* search.query({ query: "chain secret" });
      assert.equal(hiddenReasoning.results.length, 0);
      const hiddenPayload = yield* search.query({ query: "rawTerminalLog" });
      assert.equal(hiddenPayload.results.length, 0);
    }),
  );

  it.effect("applies filters and tracks projection updates, archives, and deletes", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const search = yield* makeGlobalSearch;

      const matching = yield* search.query({
        query: "reconnect",
        projectId,
        providerInstanceId: "codex-work" as never,
        model: "gpt-5.1-codex",
        status: "ready",
        dateFrom: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(matching.results.length > 0, true);

      const wrongProvider = yield* search.query({
        query: "reconnect",
        providerInstanceId: "other-provider" as never,
      });
      assert.equal(wrongProvider.results.length, 0);

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'Atomic restore verification', updated_at = '2026-01-05T00:00:00.000Z'
        WHERE message_id = 'search-message'
      `;
      assert.equal((yield* search.query({ query: "durable snapshot" })).results.length, 0);
      assert.equal((yield* search.query({ query: "atomic restore" })).results.length, 1);

      yield* sql`
        UPDATE projection_threads
        SET archived_at = '2026-01-06T00:00:00.000Z'
        WHERE thread_id = 'search-thread'
      `;
      assert.equal((yield* search.query({ query: "atomic restore" })).results.length, 0);
      assert.equal(
        (yield* search.query({ query: "atomic restore", includeArchived: true })).results.length,
        1,
      );

      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'search-message'`;
      assert.equal(
        (yield* search.query({ query: "atomic restore", includeArchived: true })).results.length,
        0,
      );
    }),
  );

  it.effect("orders matches by most recent before relevance", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const search = yield* makeGlobalSearch;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'search-old-repeated', 'search-thread', 'search-turn', 'info', 'status',
          'ClickHouse ClickHouse ClickHouse ClickHouse', '{}', 10,
          '2026-01-03T00:00:03.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, reasoning_text,
          is_streaming, created_at, updated_at
        ) VALUES (
          'search-recent-clickhouse', 'search-thread', 'search-turn', 'user',
          'Please check ClickHouse', NULL, 0,
          '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z'
        )
      `;

      const result = yield* search.query({ query: "ClickHouse" });
      assert.equal(result.results[0]?.documentKey, "message:search-recent-clickhouse");
    }),
  );
});
