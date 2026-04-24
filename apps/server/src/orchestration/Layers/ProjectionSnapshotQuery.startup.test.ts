import { CheckpointRef, EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "../readModelRetention.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const resetProjectionTables = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_proposed_plans`;
    yield* sql`DELETE FROM projection_thread_sessions`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_planning_workflows`;
    yield* sql`DELETE FROM projection_code_review_workflows`;
    yield* sql`DELETE FROM projection_project_skills`;
    yield* sql`DELETE FROM projection_project_memories`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_state`;
  });

const withoutTransactions = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const client = sql as any;
      const originalWithTransaction = client.withTransaction;
      client.withTransaction = () => Effect.never;
      return originalWithTransaction;
    }),
    () => effect,
    (originalWithTransaction) =>
      Effect.sync(() => {
        (sql as any).withTransaction = originalWithTransaction;
      }),
  );

const withQueryTimeout = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      onTimeout: () => Effect.fail(new Error(`Timed out waiting for ${label}`)),
    }),
  );

const seedProjectionFixture = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* resetProjectionTables(sql);

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
        '[]',
        '2026-04-01T09:00:00.000Z',
        '2026-04-01T09:00:01.000Z',
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
        tasks_json,
        tasks_turn_id,
        tasks_updated_at,
        compaction_json,
        session_notes_json,
        thread_references_json,
        archived_at,
        created_at,
        last_interaction_at,
        updated_at,
        deleted_at,
        estimated_context_tokens
      )
      VALUES (
        'thread-1',
        'project-1',
        'Thread 1',
        'gpt-5-codex',
        'full-access',
        'default',
        'feature/lazy-startup',
        '/tmp/project-1/worktrees/thread-1',
        'turn-1',
        ${JSON.stringify([
          {
            id: "task-1",
            content: "Implement lazy thread details",
            activeForm: "Implementing lazy thread details",
            status: "in_progress",
          },
        ])},
        'turn-1',
        '2026-04-01T09:00:06.500Z',
        ${JSON.stringify({
          summary: "Compacted earlier context",
          trigger: "manual",
          estimatedTokens: 1200,
          modelContextWindowTokens: 1000000,
          createdAt: "2026-04-01T09:00:05.000Z",
          direction: "up_to",
          pivotMessageId: "message-1",
          fromTurnCount: 1,
          toTurnCount: 1,
        })},
        ${JSON.stringify({
          title: "Thread notes",
          currentState: "Implementing startup snapshot",
          taskSpecification: "Split startup snapshot from thread details",
          filesAndFunctions: "store.ts, ProjectionSnapshotQuery.ts",
          workflow: "default",
          errorsAndCorrections: "none",
          codebaseAndSystemDocumentation: "Projection DB read model",
          learnings: "Activities are cheap enough to keep in summary",
          keyResults: "Sidebar can render before messages load",
          worklog: "Introduced getStartupSnapshot and getThreadDetails",
          updatedAt: "2026-04-01T09:00:06.000Z",
          sourceLastInteractionAt: "2026-04-01T09:00:08.500Z",
        })},
        ${JSON.stringify([
          {
            threadId: "thread-2",
            relation: "research",
            createdAt: "2026-04-01T09:00:07.000Z",
          },
        ])},
        NULL,
        '2026-04-01T09:00:02.000Z',
        '2026-04-01T09:00:08.500Z',
        '2026-04-01T09:00:03.000Z',
        NULL,
        1200
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
        attachments_json,
        is_streaming,
        created_at,
        updated_at
      )
      VALUES (
        'message-1',
        'thread-1',
        'turn-1',
        'assistant',
        'Loaded on demand',
        'Thinking about startup performance',
        NULL,
        0,
        '2026-04-01T09:00:04.000Z',
        '2026-04-01T09:00:05.000Z'
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
        '# Lazy details',
        NULL,
        NULL,
        '2026-04-01T09:00:05.000Z',
        '2026-04-01T09:00:05.500Z'
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
        sequence,
        created_at
      )
      VALUES (
        'activity-1',
        'thread-1',
        'turn-1',
        'info',
        'runtime.note',
        'sidebar-safe activity',
        '{"stage":"start"}',
        11,
        '2026-04-01T09:00:06.000Z'
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
        'full-access',
        'turn-1',
        NULL,
        1200,
        'estimated',
        '2026-04-01T09:00:07.000Z'
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
        '2026-04-01T09:00:08.000Z',
        '2026-04-01T09:00:08.000Z',
        '2026-04-01T09:00:08.000Z',
        1,
        'checkpoint-1',
        'ready',
        '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
      )
    `;

    const sequence = 7;
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
          '2026-04-01T09:00:09.000Z'
        )
      `;
    }
  });

projectionSnapshotLayer("ProjectionSnapshotQuery lazy loading", (it) => {
  it.effect("getStartupSnapshot omits heavyweight detail fields but preserves summary data", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      const startupResult = yield* snapshotQuery.getStartupSnapshot();
      const startupSnapshot = startupResult.snapshot;

      assert.equal(startupSnapshot.snapshotSequence, fullSnapshot.snapshotSequence);
      assert.equal(startupSnapshot.updatedAt, fullSnapshot.updatedAt);
      assert.equal(startupSnapshot.threads.length, 1);
      assert.equal(startupResult.threadTailDetails, null);

      const thread = startupSnapshot.threads[0];
      assert.isDefined(thread);
      assert.equal(thread.id, asThreadId("thread-1"));
      assert.equal(thread.branch, "feature/lazy-startup");
      assert.equal(thread.worktreePath, "/tmp/project-1/worktrees/thread-1");
      assert.equal(thread.messages.length, 0);
      assert.equal(thread.checkpoints.length, 0);
      assert.deepEqual(thread.tasks, []);
      assert.equal(thread.tasksTurnId, null);
      assert.equal(thread.tasksUpdatedAt, null);
      assert.equal(thread.compaction, null);
      assert.equal(thread.estimatedContextTokens, 1200);
      assert.equal(thread.sessionNotes, null);
      assert.deepEqual(thread.threadReferences, []);
      assert.deepEqual(thread.session, {
        threadId: asThreadId("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: asTurnId("turn-1"),
        lastError: null,
        estimatedContextTokens: 1200,
        tokenUsageSource: "estimated",
        updatedAt: "2026-04-01T09:00:07.000Z",
      });
      assert.deepEqual(thread.proposedPlans, [
        {
          id: "plan-1",
          turnId: asTurnId("turn-1"),
          planMarkdown: "# Lazy details",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-04-01T09:00:05.000Z",
          updatedAt: "2026-04-01T09:00:05.500Z",
        },
      ]);
      assert.deepEqual(thread.activities, []);
    }),
  );

  it.effect("getStartupSnapshot skips decoding thread detail JSON columns", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);
      yield* sql`
        UPDATE projection_threads
        SET
          tasks_json = ${"not-json"},
          compaction_json = ${"not-json"},
          session_notes_json = ${"not-json"},
          thread_references_json = ${"not-json"}
        WHERE thread_id = 'thread-1'
      `;

      const startupResult = yield* snapshotQuery.getStartupSnapshot();
      const startupSnapshot = startupResult.snapshot;
      const thread = startupSnapshot.threads[0];

      assert.isDefined(thread);
      assert.equal(thread.id, asThreadId("thread-1"));
      assert.deepEqual(thread.tasks, []);
      assert.equal(thread.compaction, null);
      assert.equal(thread.sessionNotes, null);
      assert.deepEqual(thread.threadReferences, []);
      assert.equal(startupResult.threadTailDetails, null);
    }),
  );

  it.effect("getStartupSnapshot can bundle one thread's detail payload", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);

      const startupResult = yield* snapshotQuery.getStartupSnapshot({
        detailThreadId: asThreadId("thread-1"),
      });

      assert.equal(startupResult.snapshot.threads.length, 1);
      assert.deepEqual(startupResult.threadTailDetails, {
        threadId: asThreadId("thread-1"),
        messages: [
          {
            id: asMessageId("message-1"),
            role: "assistant",
            text: "Loaded on demand",
            reasoningText: "Thinking about startup performance",
            turnId: asTurnId("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T09:00:04.000Z",
            updatedAt: "2026-04-01T09:00:05.000Z",
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
            completedAt: "2026-04-01T09:00:08.000Z",
          },
        ],
        activities: [
          {
            id: asEventId("activity-1"),
            tone: "info",
            kind: "runtime.note",
            summary: "sidebar-safe activity",
            payload: { stage: "start" },
            turnId: asTurnId("turn-1"),
            sequence: 11,
            createdAt: "2026-04-01T09:00:06.000Z",
          },
        ],
        commandExecutions: [],
        tasks: [
          {
            id: "task-1",
            content: "Implement lazy thread details",
            activeForm: "Implementing lazy thread details",
            status: "in_progress",
          },
        ],
        tasksTurnId: asTurnId("turn-1"),
        tasksUpdatedAt: "2026-04-01T09:00:06.500Z",
        sessionNotes: {
          title: "Thread notes",
          currentState: "Implementing startup snapshot",
          taskSpecification: "Split startup snapshot from thread details",
          filesAndFunctions: "store.ts, ProjectionSnapshotQuery.ts",
          workflow: "default",
          errorsAndCorrections: "none",
          codebaseAndSystemDocumentation: "Projection DB read model",
          learnings: "Activities are cheap enough to keep in summary",
          keyResults: "Sidebar can render before messages load",
          worklog: "Introduced getStartupSnapshot and getThreadDetails",
          updatedAt: "2026-04-01T09:00:06.000Z",
          sourceLastInteractionAt: "2026-04-01T09:00:08.500Z",
        },
        threadReferences: [
          {
            threadId: asThreadId("thread-2"),
            relation: "research",
            createdAt: "2026-04-01T09:00:07.000Z",
          },
        ],
        hasOlderMessages: false,
        hasOlderCheckpoints: false,
        hasOlderCommandExecutions: false,
        oldestLoadedMessageCursor: {
          createdAt: "2026-04-01T09:00:04.000Z",
          messageId: asMessageId("message-1"),
        },
        oldestLoadedCheckpointTurnCount: 1,
        oldestLoadedCommandExecutionCursor: null,
        detailSequence: startupResult.snapshot.snapshotSequence,
      });
    }),
  );

  it.effect(
    "bootstrap snapshots retain only the newest per-thread history within projector limits",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedProjectionFixture(sql);

        const baseTimeMs = Date.parse("2026-04-01T10:00:00.000Z");

        for (let index = 2; index <= MAX_THREAD_MESSAGES + 3; index += 1) {
          const timestamp = new Date(baseTimeMs + index * 1_000).toISOString();
          yield* sql`
            INSERT INTO projection_thread_messages (
              message_id,
              thread_id,
              turn_id,
              role,
              text,
              reasoning_text,
              attachments_json,
              is_streaming,
              created_at,
              updated_at
            )
            VALUES (
              ${`message-${index}`},
              'thread-1',
              ${`turn-${index}`},
              'assistant',
              ${`Message ${index}`},
              NULL,
              NULL,
              0,
              ${timestamp},
              ${timestamp}
            )
          `;
        }

        for (let index = 2; index <= MAX_THREAD_PROPOSED_PLANS + 3; index += 1) {
          const timestamp = new Date(baseTimeMs + index * 2_000).toISOString();
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
              ${`plan-${index}`},
              'thread-1',
              ${`turn-${index}`},
              ${`# Plan ${index}`},
              NULL,
              NULL,
              ${timestamp},
              ${timestamp}
            )
          `;
        }

        for (let index = 2; index <= MAX_THREAD_ACTIVITIES + 3; index += 1) {
          const timestamp = new Date(baseTimeMs + index * 3_000).toISOString();
          yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${`activity-${index}`},
              'thread-1',
              ${`turn-${index}`},
              'info',
              'tool.completed',
              ${`Activity ${index}`},
              ${JSON.stringify({ index })},
              ${index},
              ${timestamp}
            )
          `;
        }

        for (let index = 2; index <= MAX_THREAD_CHECKPOINTS + 3; index += 1) {
          const timestamp = new Date(baseTimeMs + index * 4_000).toISOString();
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
              ${`turn-${index}`},
              NULL,
              ${`message-${Math.min(index, MAX_THREAD_MESSAGES + 3)}`},
              'completed',
              ${timestamp},
              ${timestamp},
              ${timestamp},
              ${index},
              ${`checkpoint-${index}`},
              'ready',
              '[]'
            )
          `;
        }

        const bootstrapSnapshot = yield* snapshotQuery.getBootstrapSnapshot();
        const bootstrapThread = bootstrapSnapshot.threads[0];

        assert.isDefined(bootstrapThread);

        assert.deepEqual(bootstrapThread.tasks, [
          {
            id: "task-1",
            content: "Implement lazy thread details",
            activeForm: "Implementing lazy thread details",
            status: "in_progress",
          },
        ]);
        assert.equal(bootstrapThread.compaction?.summary, "Compacted earlier context");
        assert.equal(bootstrapThread.sessionNotes?.title, "Thread notes");
        assert.deepEqual(bootstrapThread.threadReferences, [
          {
            threadId: asThreadId("thread-2"),
            relation: "research",
            createdAt: "2026-04-01T09:00:07.000Z",
          },
        ]);
        assert.equal(bootstrapThread.messages.length, MAX_THREAD_MESSAGES);
        assert.equal(bootstrapThread.messages[0]?.id, asMessageId("message-4"));
        assert.equal(
          bootstrapThread.messages.at(-1)?.id,
          asMessageId(`message-${MAX_THREAD_MESSAGES + 3}`),
        );
        assert.equal(bootstrapThread.proposedPlans.length, MAX_THREAD_PROPOSED_PLANS);
        assert.equal(bootstrapThread.proposedPlans[0]?.id, "plan-4");
        assert.equal(bootstrapThread.activities.length, MAX_THREAD_ACTIVITIES);
        assert.equal(bootstrapThread.activities[0]?.id, asEventId("activity-5"));
        assert.equal(bootstrapThread.checkpoints.length, MAX_THREAD_CHECKPOINTS);
        assert.equal(bootstrapThread.checkpoints[0]?.turnId, asTurnId("turn-4"));
        assert.equal(
          bootstrapThread.checkpoints.at(-1)?.turnId,
          asTurnId(`turn-${MAX_THREAD_CHECKPOINTS + 3}`),
        );
      }),
  );

  it.effect(
    "getSnapshot, getBootstrapSnapshot, and getStartupSnapshot do not depend on read transactions",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedProjectionFixture(sql);

        const [snapshot, bootstrapSnapshot, startupResult] = yield* withoutTransactions(
          sql,
          Effect.all(
            [
              withQueryTimeout("getSnapshot", snapshotQuery.getSnapshot()),
              withQueryTimeout("getBootstrapSnapshot", snapshotQuery.getBootstrapSnapshot()),
              withQueryTimeout(
                "getStartupSnapshot",
                snapshotQuery.getStartupSnapshot({
                  detailThreadId: asThreadId("thread-1"),
                }),
              ),
            ],
            { concurrency: 1 },
          ),
        );

        assert.equal(snapshot.threads.length, 1);
        assert.equal(snapshot.threads[0]?.id, asThreadId("thread-1"));
        assert.equal(bootstrapSnapshot.threads.length, 1);
        assert.equal(bootstrapSnapshot.threads[0]?.id, asThreadId("thread-1"));
        assert.isNotNull(startupResult.threadTailDetails);
        assert.equal(startupResult.threadTailDetails.threadId, asThreadId("thread-1"));
      }),
  );

  it.effect("getThreadTailDetails and getThreadHistoryPage page thread history from the tail", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          reasoning_text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-0',
          'thread-1',
          'turn-0',
          'assistant',
          'Older history',
          NULL,
          NULL,
          0,
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.500Z'
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
          'turn-0',
          NULL,
          'message-0',
          'completed',
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.500Z',
          0,
          'checkpoint-0',
          'ready',
          '[]'
        )
      `;

      const tail = yield* snapshotQuery.getThreadTailDetails({
        threadId: asThreadId("thread-1"),
        messageLimit: 1,
        checkpointLimit: 1,
      });

      assert.deepEqual(
        tail.messages.map((message) => message.id),
        [asMessageId("message-1")],
      );
      assert.deepEqual(
        tail.checkpoints.map((checkpoint) => checkpoint.turnId),
        [asTurnId("turn-1")],
      );
      assert.deepEqual(
        tail.activities.map((activity) => activity.id),
        [asEventId("activity-1")],
      );
      assert.equal(tail.hasOlderMessages, true);
      assert.equal(tail.hasOlderCheckpoints, true);
      assert.equal(tail.hasOlderCommandExecutions, false);
      assert.deepEqual(tail.oldestLoadedMessageCursor, {
        createdAt: "2026-04-01T09:00:04.000Z",
        messageId: asMessageId("message-1"),
      });
      assert.equal(tail.oldestLoadedCheckpointTurnCount, 1);
      assert.equal(tail.oldestLoadedCommandExecutionCursor, null);

      const page = yield* snapshotQuery.getThreadHistoryPage({
        threadId: asThreadId("thread-1"),
        beforeMessageCursor: tail.oldestLoadedMessageCursor,
        beforeCheckpointTurnCount: tail.oldestLoadedCheckpointTurnCount,
        beforeCommandExecutionCursor: null,
        messageLimit: 1,
        checkpointLimit: 1,
      });

      assert.deepEqual(
        page.messages.map((message) => message.id),
        [asMessageId("message-0")],
      );
      assert.deepEqual(
        page.checkpoints.map((checkpoint) => checkpoint.turnId),
        [asTurnId("turn-0")],
      );
      assert.equal(page.hasOlderMessages, false);
      assert.equal(page.hasOlderCheckpoints, false);
      assert.equal(page.hasOlderCommandExecutions, false);
      assert.deepEqual(page.oldestLoadedMessageCursor, {
        createdAt: "2026-04-01T09:00:03.000Z",
        messageId: asMessageId("message-0"),
      });
      assert.equal(page.oldestLoadedCheckpointTurnCount, 0);
      assert.equal(page.oldestLoadedCommandExecutionCursor, null);
    }),
  );

  it.effect("thread detail reads do not depend on read transactions", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          reasoning_text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-0',
          'thread-1',
          'turn-0',
          'assistant',
          'Older history',
          NULL,
          NULL,
          0,
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.500Z'
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
          'turn-0',
          NULL,
          'message-0',
          'completed',
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.000Z',
          '2026-04-01T09:00:03.500Z',
          0,
          'checkpoint-0',
          'ready',
          '[]'
        )
      `;

      const [tail, page, details] = yield* withoutTransactions(
        sql,
        Effect.gen(function* () {
          const tail = yield* withQueryTimeout(
            "getThreadTailDetails",
            snapshotQuery.getThreadTailDetails({
              threadId: asThreadId("thread-1"),
              messageLimit: 1,
              checkpointLimit: 1,
            }),
          );
          const page = yield* withQueryTimeout(
            "getThreadHistoryPage",
            snapshotQuery.getThreadHistoryPage({
              threadId: asThreadId("thread-1"),
              beforeMessageCursor: tail.oldestLoadedMessageCursor,
              beforeCheckpointTurnCount: tail.oldestLoadedCheckpointTurnCount,
              beforeCommandExecutionCursor: null,
              messageLimit: 1,
              checkpointLimit: 1,
            }),
          );
          const details = yield* withQueryTimeout(
            "getThreadDetails",
            snapshotQuery.getThreadDetails({
              threadId: asThreadId("thread-1"),
            }),
          );

          return [tail, page, details] as const;
        }),
      );

      assert.deepEqual(
        tail.messages.map((message) => message.id),
        [asMessageId("message-1")],
      );
      assert.deepEqual(
        page.messages.map((message) => message.id),
        [asMessageId("message-0")],
      );
      assert.equal(details.threadId, asThreadId("thread-1"));
      assert.equal(details.messages.length, 2);
    }),
  );

  it.effect(
    "getStartupSnapshot returns null threadTailDetails for a missing requested thread",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedProjectionFixture(sql);

        const startupResult = yield* snapshotQuery.getStartupSnapshot({
          detailThreadId: asThreadId("thread-missing"),
        });

        assert.equal(startupResult.threadTailDetails, null);
        assert.equal(startupResult.snapshot.threads.length, 1);
      }),
  );

  it.effect(
    "getStartupSnapshot marks bundled thread tail details provisional with sequence 0",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedProjectionFixture(sql);
        yield* sql`
        DELETE FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}
      `;

        const startupResult = yield* snapshotQuery.getStartupSnapshot({
          detailThreadId: asThreadId("thread-1"),
        });

        assert.equal(startupResult.snapshot.snapshotSequence, 0);
        assert.isNotNull(startupResult.threadTailDetails);
        assert.equal(startupResult.threadTailDetails.detailSequence, 0);
      }),
  );

  it.effect(
    "getThreadDetails returns the omitted thread detail fields with a detail sequence",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* seedProjectionFixture(sql);

        const details = yield* snapshotQuery.getThreadDetails({
          threadId: asThreadId("thread-1"),
        });

        assert.deepEqual(details, {
          threadId: asThreadId("thread-1"),
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "Loaded on demand",
              reasoningText: "Thinking about startup performance",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-04-01T09:00:04.000Z",
              updatedAt: "2026-04-01T09:00:05.000Z",
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
              completedAt: "2026-04-01T09:00:08.000Z",
            },
          ],
          tasks: [
            {
              id: "task-1",
              content: "Implement lazy thread details",
              activeForm: "Implementing lazy thread details",
              status: "in_progress",
            },
          ],
          tasksTurnId: asTurnId("turn-1"),
          tasksUpdatedAt: "2026-04-01T09:00:06.500Z",
          sessionNotes: {
            title: "Thread notes",
            currentState: "Implementing startup snapshot",
            taskSpecification: "Split startup snapshot from thread details",
            filesAndFunctions: "store.ts, ProjectionSnapshotQuery.ts",
            workflow: "default",
            errorsAndCorrections: "none",
            codebaseAndSystemDocumentation: "Projection DB read model",
            learnings: "Activities are cheap enough to keep in summary",
            keyResults: "Sidebar can render before messages load",
            worklog: "Introduced getStartupSnapshot and getThreadDetails",
            updatedAt: "2026-04-01T09:00:06.000Z",
            sourceLastInteractionAt: "2026-04-01T09:00:08.500Z",
          },
          threadReferences: [
            {
              threadId: asThreadId("thread-2"),
              relation: "research",
              createdAt: "2026-04-01T09:00:07.000Z",
            },
          ],
          detailSequence: 7,
        });
      }),
  );

  it.effect("getThreadDetails marks divergent projector state as provisional", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedProjectionFixture(sql);

      let sequence = 7;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          UPDATE projection_state
          SET
            last_applied_sequence = ${sequence},
            updated_at = '2026-04-01T09:00:09.000Z'
          WHERE projector = ${projector}
        `;
        sequence += 1;
      }

      const details = yield* snapshotQuery.getThreadDetails({
        threadId: asThreadId("thread-1"),
      });

      assert.equal(details.detailSequence, 7);
    }),
  );
});
