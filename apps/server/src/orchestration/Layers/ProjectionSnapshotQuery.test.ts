import { CheckpointRef, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_project_memories`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          'gpt-5-codex',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_project_memories (
          memory_id,
          project_id,
          scope,
          type,
          name,
          description,
          body,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'memory-1',
          'project-1',
          'user',
          'feedback',
          'Avoid extra comments',
          'Keep explanations terse.',
          'Do not add unnecessary comments.',
          '2026-02-24T00:00:00.500Z',
          '2026-02-24T00:00:01.500Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          branch,
          worktree_path,
          latest_turn_id,
          estimated_context_tokens,
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          'gpt-5-codex',
          NULL,
          NULL,
          'turn-1',
          42000,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:08.500Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          reasoning_text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          'thinking from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
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
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          estimated_context_tokens,
          token_usage_source,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          42000,
          'provider',
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      const sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModel: "gpt-5-codex",
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          memories: [
            {
              id: "memory-1",
              projectId: asProjectId("project-1"),
              scope: "user",
              type: "feedback",
              name: "Avoid extra comments",
              description: "Keep explanations terse.",
              body: "Do not add unnecessary comments.",
              createdAt: "2026-02-24T00:00:00.500Z",
              updatedAt: "2026-02-24T00:00:01.500Z",
              deletedAt: null,
            },
          ],
          skills: [],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          model: "gpt-5-codex",
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
          },
          archivedAt: null,
          createdAt: "2026-02-24T00:00:02.000Z",
          lastInteractionAt: "2026-02-24T00:00:08.500Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          deletedAt: null,
          estimatedContextTokens: 42_000,
          modelContextWindowTokens: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              reasoningText: "thinking from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.makeUnsafe("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
          sessionNotes: null,
          threadReferences: [],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          compaction: null,
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            estimatedContextTokens: 42_000,
            tokenUsageSource: "provider",
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);
    }),
  );

  it.effect("uses the lowest required projector sequence when projectors diverge", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_state`;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
    }),
  );

  it.effect("compacts legacy activity payloads when hydrating snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_code_review_workflows`;
      yield* sql`DELETE FROM projection_planning_workflows`;
      yield* sql`DELETE FROM projection_project_memories`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-compact',
          'Compact Project',
          '/tmp/project-compact',
          'gpt-5-codex',
          '[]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
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
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-compact',
          'project-compact',
          'Compact Thread',
          'gpt-5-codex',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-02-24T00:00:01.000Z',
          '2026-02-24T00:00:03.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-command',
            'thread-compact',
            'turn-compact',
            'tool',
            'tool.completed',
            'Ran command',
            ${JSON.stringify({
              itemType: "command_execution",
              title: "Ran command",
              detail: "bun run lint",
              data: {
                item: {
                  command: ["bun", "run", "lint"],
                },
              },
            })},
            '2026-02-24T00:00:02.000Z'
          ),
          (
            'activity-files',
            'thread-compact',
            'turn-compact',
            'tool',
            'tool.completed',
            'File change',
            ${JSON.stringify({
              itemType: "file_change",
              detail: "updated files",
              data: {
                patch: "*** Begin Patch\n*** Update File: README.md\n*** End Patch",
              },
            })},
            '2026-02-24T00:00:02.500Z'
          ),
          (
            'activity-runtime',
            'thread-compact',
            NULL,
            'info',
            'runtime.configured',
            'Runtime configured',
            ${JSON.stringify({
              model: "claude-haiku-4-5",
              claudeCodeVersion: "2.1.80",
              sessionId: "session-123",
              config: {
                model: "claude-haiku-4-5",
                claude_code_version: "2.1.80",
                session_id: "session-123",
                instructionProfile: {
                  contractVersion: "v2",
                  providerSupplementVersion: "v7",
                  strategy: "claude.append_system_prompt",
                },
              },
            })},
            '2026-02-24T00:00:02.750Z'
          )
      `;

      const sequence = 20;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:03.500Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-compact"),
      );
      assert.isDefined(thread);

      const commandActivity = thread?.activities.find(
        (entry) => entry.id === asEventId("activity-command"),
      );
      assert.isDefined(commandActivity);
      assert.deepEqual(commandActivity?.payload, {
        itemType: "command_execution",
        title: "Ran command",
        detail: "bun run lint",
        command: "bun run lint",
      });

      const fileActivity = thread?.activities.find(
        (entry) => entry.id === asEventId("activity-files"),
      );
      assert.isDefined(fileActivity);
      assert.deepEqual(fileActivity?.payload, {
        itemType: "file_change",
        detail: "updated files",
        changedFiles: ["README.md"],
      });

      const runtimeActivity = thread?.activities.find(
        (entry) => entry.id === asEventId("activity-runtime"),
      );
      assert.isDefined(runtimeActivity);
      assert.deepEqual(runtimeActivity?.payload, {
        model: "claude-haiku-4-5",
        claudeCodeVersion: "2.1.80",
        sessionId: "session-123",
        instructionContractVersion: "v2",
        instructionSupplementVersion: "v7",
        instructionStrategy: "claude.append_system_prompt",
      });
    }),
  );

  it.effect("orders threads by lastInteractionAt and projects by hottest child activity", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_project_memories`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-empty',
            'Empty',
            '/tmp/project-empty',
            'gpt-5-codex',
            '[]',
            '2026-02-24T00:00:03.000Z',
            '2026-02-24T00:00:03.000Z',
            NULL
          ),
          (
            'project-cold',
            'Cold',
            '/tmp/project-cold',
            'gpt-5-codex',
            '[]',
            '2026-02-24T00:00:01.000Z',
            '2026-02-24T00:00:01.000Z',
            NULL
          ),
          (
            'project-hot',
            'Hot',
            '/tmp/project-hot',
            'gpt-5-codex',
            '[]',
            '2026-02-24T00:00:02.000Z',
            '2026-02-24T00:00:02.000Z',
            NULL
          )
      `;

      yield* sql`
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
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-hot-older',
            'project-hot',
            'Hot older',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:00.000Z',
            '2026-02-24T00:00:05.000Z',
            '2026-02-24T00:00:05.000Z',
            NULL
          ),
          (
            'thread-hot-newer',
            'project-hot',
            'Hot newer',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:04.000Z',
            '2026-02-24T00:00:05.000Z',
            '2026-02-24T00:00:05.000Z',
            NULL
          ),
          (
            'thread-cold',
            'project-cold',
            'Cold thread',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:06.000Z',
            '2026-02-24T00:00:04.000Z',
            '2026-02-24T00:00:04.000Z',
            NULL
          ),
          (
            'thread-deleted',
            'project-cold',
            'Deleted thread',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:07.000Z',
            '2026-02-24T00:00:08.000Z',
            '2026-02-24T00:00:08.000Z',
            '2026-02-24T00:00:08.000Z'
          )
      `;

      const sequence = 10;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.deepEqual(
        snapshot.threads.map((thread) => ({
          id: thread.id,
          lastInteractionAt: thread.lastInteractionAt,
        })),
        [
          {
            id: ThreadId.makeUnsafe("thread-deleted"),
            lastInteractionAt: "2026-02-24T00:00:08.000Z",
          },
          {
            id: ThreadId.makeUnsafe("thread-hot-newer"),
            lastInteractionAt: "2026-02-24T00:00:05.000Z",
          },
          {
            id: ThreadId.makeUnsafe("thread-hot-older"),
            lastInteractionAt: "2026-02-24T00:00:05.000Z",
          },
          {
            id: ThreadId.makeUnsafe("thread-cold"),
            lastInteractionAt: "2026-02-24T00:00:04.000Z",
          },
        ],
      );

      assert.deepEqual(
        snapshot.projects.map((project) => project.id),
        [
          ProjectId.makeUnsafe("project-hot"),
          ProjectId.makeUnsafe("project-cold"),
          ProjectId.makeUnsafe("project-empty"),
        ],
      );
    }),
  );

  it.effect("ignores archived workflow child activity when ordering projects", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_code_review_workflows`;
      yield* sql`DELETE FROM projection_planning_workflows`;
      yield* sql`DELETE FROM projection_project_memories`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-hidden',
            'Hidden',
            '/tmp/project-hidden',
            'gpt-5-codex',
            '[]',
            '2026-02-24T00:00:02.000Z',
            '2026-02-24T00:00:02.000Z',
            NULL
          ),
          (
            'project-visible',
            'Visible',
            '/tmp/project-visible',
            'gpt-5-codex',
            '[]',
            '2026-02-24T00:00:01.000Z',
            '2026-02-24T00:00:01.000Z',
            NULL
          )
      `;

      yield* sql`
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
          created_at,
          last_interaction_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'hidden-author-thread',
            'project-hidden',
            'Hidden author',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:03.000Z',
            '2026-02-24T00:00:09.000Z',
            '2026-02-24T00:00:09.000Z',
            NULL
          ),
          (
            'visible-thread',
            'project-visible',
            'Visible thread',
            'gpt-5-codex',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-02-24T00:00:04.000Z',
            '2026-02-24T00:00:08.000Z',
            '2026-02-24T00:00:08.000Z',
            NULL
          )
      `;

      const archivedWorkflow = JSON.stringify({
        id: "workflow-hidden",
        projectId: "project-hidden",
        title: "Archived workflow",
        slug: "archived-workflow",
        requirementPrompt: "Ship it",
        plansDirectory: "plans",
        selfReviewEnabled: true,
        branchA: {
          branchId: "a",
          authorSlot: { provider: "codex", model: "gpt-5-codex" },
          authorThreadId: "hidden-author-thread",
          planFilePath: null,
          planTurnId: null,
          revisionTurnId: null,
          reviews: [],
          status: "pending",
          error: null,
          updatedAt: "2026-02-24T00:00:09.000Z",
        },
        branchB: {
          branchId: "b",
          authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
          authorThreadId: "hidden-author-thread-b",
          planFilePath: null,
          planTurnId: null,
          revisionTurnId: null,
          reviews: [],
          status: "pending",
          error: null,
          updatedAt: "2026-02-24T00:00:09.000Z",
        },
        merge: {
          mergeSlot: { provider: "codex", model: "gpt-5-codex" },
          threadId: null,
          outputFilePath: null,
          turnId: null,
          approvedPlanId: null,
          status: "not_started",
          error: null,
          updatedAt: "2026-02-24T00:00:09.000Z",
        },
        implementation: null,
        createdAt: "2026-02-24T00:00:09.000Z",
        updatedAt: "2026-02-24T00:00:09.000Z",
        archivedAt: "2026-02-24T00:00:09.000Z",
        deletedAt: null,
      });

      yield* sql`
        INSERT INTO projection_planning_workflows (
          workflow_id,
          project_id,
          workflow_json,
          updated_at,
          deleted_at
        )
        VALUES (
          'workflow-hidden',
          'project-hidden',
          ${archivedWorkflow},
          '2026-02-24T00:00:09.000Z',
          NULL
        )
      `;

      const sequence = 10;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:10.000Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.deepEqual(
        snapshot.projects.map((project) => project.id),
        [ProjectId.makeUnsafe("project-visible"), ProjectId.makeUnsafe("project-hidden")],
      );
    }),
  );
});
