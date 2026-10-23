import Migration0129 from "../../persistence/Migrations/134_BackgroundWorkEffort.ts";
import {
  EventId,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0066 from "../../persistence/Migrations/066_ThreadBackgroundWork.ts";
import Migration0111 from "../../persistence/Migrations/111_ThreadBackgroundWorkIdentity.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { ThreadBackgroundWork } from "../Services/ThreadBackgroundWork.ts";
import { ThreadBackgroundWorkLive, transitionFromProviderEvent } from "./ThreadBackgroundWork.ts";

const threadId = ThreadId.makeUnsafe("background-thread");
const turnId = TurnId.makeUnsafe("background-turn");

const directory: ProviderSessionDirectoryShape = {
  upsert: () => Effect.void,
  getProvider: () => Effect.succeed("claudeAgent"),
  getBinding: () =>
    Effect.succeed(
      Option.some({
        threadId,
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        adapterKey: "claudeAgent",
        launchFingerprint: "launch-fingerprint",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      }),
    ),
  listThreadIds: () => Effect.succeed([threadId]),
  listBindings: () => Effect.succeed([]),
  updateMcpStateIfCurrent: () => Effect.succeed(true),
  updateHistoryReconciliationIfCurrent: () => Effect.succeed(true),
  updateTerminalLifecycleIfCurrent: () => Effect.succeed(true),
  listBindingsByProject: () => Effect.succeed([]),
};

const testLayer = ThreadBackgroundWorkLive.pipe(
  Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
  Layer.provideMerge(SqliteClient.layerMemory()),
);

const migrateBackgroundWork = Effect.gen(function* () {
  yield* Migration0066;
  yield* Migration0111;
  yield* Migration0129;
});

function eventBase(index: number) {
  return {
    eventId: EventId.makeUnsafe(`background-event-${index}`),
    provider: "claudeAgent" as const,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    threadId,
    turnId,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

it("classifies inert, monitor, and workflow task starts", () => {
  const monitor = transitionFromProviderEvent({
    ...eventBase(1),
    type: "task.started",
    payload: { taskId: RuntimeTaskId.makeUnsafe("monitor-1"), taskType: "local_bash" },
  });
  const inert = transitionFromProviderEvent({
    ...eventBase(2),
    type: "task.started",
    payload: { taskId: RuntimeTaskId.makeUnsafe("plan-1"), taskType: "plan" },
  });
  const workflow = transitionFromProviderEvent({
    ...eventBase(3),
    type: "task.started",
    payload: { taskId: RuntimeTaskId.makeUnsafe("workflow-1"), taskType: "local_workflow" },
  });

  assert.equal(monitor?.classification, "monitoring");
  assert.equal(monitor?.status, "monitoring");
  assert.equal(inert?.classification, "inert");
  assert.equal(inert?.active, false);
  assert.equal(workflow?.classification, "working");
  assert.equal(workflow?.ownership, "workflow");
});

it.layer(testLayer)("ThreadBackgroundWork", (it) => {
  it.effect("persists liveness, bounds output, and expires stale work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const taskId = RuntimeTaskId.makeUnsafe("monitor-1");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.started",
        payload: { taskId, taskType: "local_bash", description: "Watching logs" },
      });

      let snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries.length, 1);
      assert.equal(snapshot.entries[0]?.classification, "monitoring");
      assert.equal(snapshot.entries[0]?.active, true);
      assert.match(snapshot.entries[0]?.providerSessionIdentity ?? "", /launch-fingerprint/);

      yield* work.recordProviderEvent({
        ...eventBase(2),
        type: "task.progress",
        payload: {
          taskId,
          description: "x".repeat(20_000),
          lastToolName: "tail",
        },
      });
      snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries[0]?.classification, "monitoring");
      assert.equal(snapshot.entries[0]?.outputTruncated, true);
      assert.equal(
        Buffer.byteLength(snapshot.entries[0]?.latestOutput ?? "", "utf8") <= 8 * 1024,
        true,
      );

      const protectedBefore = yield* work.listProtectedThreadIds({
        freshSince: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(protectedBefore.has(threadId), true);
      yield* work.expireStale({
        freshSince: "2026-01-01T00:00:03.000Z",
        expiredAt: "2026-01-01T00:00:04.000Z",
      });

      const protectedAfter = yield* work.listProtectedThreadIds({
        freshSince: "2026-01-01T00:00:03.000Z",
      });
      assert.equal(protectedAfter.has(threadId), false);
      snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries[0]?.active, false);
      assert.equal(snapshot.entries[0]?.status, "stopped");
    }),
  );

  it.effect(
    "persists subagent completion and clears protection despite duplicate notifications",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
        yield* migrateBackgroundWork;
        yield* sql`DELETE FROM projection_thread_background_work`;
        const work = yield* ThreadBackgroundWork;
        yield* work.recordProviderEvent({
          ...eventBase(1),
          provider: "codex",
          type: "subagent.activity",
          payload: { kind: "started", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        });
        const freshSince = "2026-01-01T00:00:00.000Z";
        assert.equal((yield* work.listProtectedThreadIds({ freshSince })).has(threadId), true);
        for (const index of [2, 3]) {
          yield* work.recordProviderEvent({
            ...eventBase(index),
            provider: "codex",
            type: "subagent.activity",
            payload: { kind: "completed", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
          });
          const snapshot = yield* work.getSnapshot;
          assert.equal(snapshot.entries.length, 1);
          assert.equal(snapshot.entries[0]?.status, "completed");
          assert.equal(snapshot.entries[0]?.active, false);
          assert.equal(snapshot.entries[0]?.ownership, "direct-subagent");
          assert.equal((yield* work.listProtectedThreadIds({ freshSince })).has(threadId), false);
          const rows =
            yield* sql`SELECT status, active, completed_at FROM projection_thread_background_work`;
          assert.equal(rows[0]?.status, "completed");
          assert.equal(rows[0]?.active, 0);
          assert.equal(rows[0]?.completed_at, eventBase(2).createdAt);
        }

        yield* work.recordProviderEvent({
          ...eventBase(4),
          provider: "codex",
          type: "subagent.activity",
          payload: { kind: "interacted", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        });
        const reactivated = yield* work.getSnapshot;
        assert.equal(reactivated.entries[0]?.status, "running");
        assert.equal(reactivated.entries[0]?.active, true);
        assert.equal(reactivated.entries[0]?.completedAt, null);
        assert.equal((yield* work.listProtectedThreadIds({ freshSince })).has(threadId), true);

        yield* work.recordProviderEvent({
          ...eventBase(5),
          provider: "codex",
          type: "subagent.activity",
          payload: { kind: "completed", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        });
        const completedAgain = yield* work.getSnapshot;
        assert.equal(completedAgain.entries[0]?.completedAt, eventBase(5).createdAt);
        assert.equal(completedAgain.entries[0]?.active, false);
        assert.equal((yield* work.listProtectedThreadIds({ freshSince })).has(threadId), false);
      }),
  );

  it.effect("records completion without an earlier start as inactive and unprotected", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;
      const work = yield* ThreadBackgroundWork;
      yield* work.recordProviderEvent({
        ...eventBase(1),
        provider: "codex",
        type: "subagent.activity",
        payload: { kind: "completed", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
      });
      const snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries.length, 1);
      assert.equal(snapshot.entries[0]?.status, "completed");
      assert.equal(snapshot.entries[0]?.active, false);
      assert.equal(snapshot.entries[0]?.completedAt, eventBase(1).createdAt);
      const protectedThreads = yield* work.listProtectedThreadIds({
        freshSince: "2026-01-01T00:00:00.000Z",
      });
      assert.equal(protectedThreads.has(threadId), false);
    }),
  );

  it.effect("marks all active work terminal when its provider session exits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "subagent.activity",
        payload: { kind: "started", agentThreadId: "agent-1", agentPath: "root/agent-1" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        type: "session.exited",
        payload: { reason: "provider stopped" },
      });

      const snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries[0]?.active, false);
      assert.equal(snapshot.entries[0]?.status, "stopped");
    }),
  );

  it.effect("ignores progress when its task start was never stored", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;
      const work = yield* ThreadBackgroundWork;
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe("never-started"),
          description: "Late heartbeat",
        },
      });
      assert.equal((yield* work.getSnapshot).entries.length, 0);
    }),
  );

  it.effect("keeps inert work inactive when a progress event follows its start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const taskId = RuntimeTaskId.makeUnsafe("plan-1");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.started",
        payload: { taskId, taskType: "plan" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        type: "task.progress",
        payload: { taskId, description: "Drafting a plan" },
      });

      const snapshot = yield* work.getSnapshot;
      assert.equal(snapshot.entries[0]?.classification, "inert");
      assert.equal(snapshot.entries[0]?.active, false);
      assert.equal(snapshot.entries[0]?.status, "idle");
    }),
  );

  it.effect("does not let delayed progress reactivate completed work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const taskId = RuntimeTaskId.makeUnsafe("out-of-order-task");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.started",
        payload: { taskId, taskType: "agent" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(3),
        type: "task.completed",
        payload: { taskId, status: "completed", summary: "Done" },
      });
      for (const timestamp of [2, 4]) {
        yield* work.recordProviderEvent({
          ...eventBase(timestamp),
          type: "task.progress",
          payload: { taskId, description: "Delayed progress" },
        });
      }

      const entry = (yield* work.getSnapshot).entries[0];
      assert.equal(entry?.status, "completed");
      assert.equal(entry?.active, false);
      assert.equal(entry?.latestOutput, "Done");
      assert.equal(entry?.updatedAt, eventBase(3).createdAt);
    }),
  );

  it.effect("bounds snapshots and periodically prunes persisted history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      for (let index = 0; index < 300; index += 1) {
        yield* work.recordProviderEvent({
          ...eventBase(index),
          type: "task.started",
          payload: { taskId: RuntimeTaskId.makeUnsafe(`task-${index}`), taskType: "agent" },
        });
      }

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_background_work
        WHERE thread_id = ${threadId}
      `;
      assert.ok((rows[0]?.count ?? Number.POSITIVE_INFINITY) <= 299);
      assert.equal((yield* work.getSnapshot).entries.length, 200);
    }),
  );

  it.effect("keeps title, kind and type stable while progress reports the last tool", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const shellId = RuntimeTaskId.makeUnsafe("shell-1");
      const agentId = RuntimeTaskId.makeUnsafe("agent-1");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.started",
        payload: { taskId: shellId, taskType: "local_bash", description: "Run browser suite" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        type: "task.started",
        payload: { taskId: agentId, taskType: "local_agent", description: "Review the diff" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(3),
        type: "task.progress",
        payload: { taskId: agentId, description: "Reading files", lastToolName: "Read" },
      });

      const entries = (yield* work.getSnapshot).entries;
      const shell = entries.find((entry) => entry.workItemId === shellId);
      const agent = entries.find((entry) => entry.workItemId === agentId);
      assert.equal(shell?.kind, "shell");
      assert.equal(shell?.title, "Run browser suite");
      assert.equal(agent?.kind, "agent");
      assert.equal(agent?.title, "Review the diff");
      assert.equal(agent?.phase, "local_agent");
      assert.equal(agent?.lastTool, "Read");
      assert.equal(agent?.latestOutput, "Reading files");
    }),
  );

  it.effect("records title and prompt from collaboration tool calls", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const itemId = RuntimeItemId.makeUnsafe("tool-use-1");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        itemId,
        type: "item.started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: {
            input: {
              description: "Explore the agents panel",
              prompt: "Find every consumer of the agents snapshot.",
              subagent_type: "Explore",
            },
          },
        },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        itemId,
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          data: { input: { description: "A later description" } },
        },
      });

      const entry = (yield* work.getThreadSnapshot(threadId)).entries[0];
      assert.equal(entry?.kind, "agent");
      assert.equal(entry?.title, "Explore the agents panel");
      assert.equal(entry?.prompt, "Find every consumer of the agents snapshot.");
      assert.equal(entry?.phase, "Explore");

      // Global snapshots are pushed to every client and leave the prompt out.
      const global = (yield* work.getSnapshot).entries[0];
      assert.equal(global?.title, "Explore the agents panel");
      assert.equal(global?.prompt, null);
    }),
  );

  it.effect("only stores real descriptions as titles", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const itemId = RuntimeItemId.makeUnsafe("tool-use-typed");
      // The first event knows the type but not the description yet.
      yield* work.recordProviderEvent({
        ...eventBase(1),
        itemId,
        type: "item.started",
        payload: {
          itemType: "collab_agent_tool_call",
          data: { input: { subagent_type: "Explore" } },
        },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        itemId,
        type: "item.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          data: { input: { description: "Map the agents panel" } },
        },
      });
      yield* work.recordProviderEvent({
        ...eventBase(3),
        type: "subagent.activity",
        payload: { kind: "started", agentThreadId: "agent-thread-1", agentPath: "/root/explorer" },
      });

      const entries = (yield* work.getSnapshot).entries;
      const collab = entries.find((entry) => entry.workItemId === itemId);
      const subagent = entries.find((entry) => entry.workItemId === "subagent:agent-thread-1");
      assert.equal(collab?.title, "Map the agents panel");
      assert.equal(collab?.phase, "Explore");
      // The path stays the type; the client derives a fallback name from it.
      assert.equal(subagent?.title, null);
      assert.equal(subagent?.phase, "/root/explorer");
    }),
  );

  it.effect("dismisses only settled work and restores it when it becomes active", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const otherThreadId = ThreadId.makeUnsafe("background-thread-other");
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${otherThreadId})`;
      yield* migrateBackgroundWork;
      yield* sql`DELETE FROM projection_thread_background_work`;

      const work = yield* ThreadBackgroundWork;
      const start = (index: number, taskId: string, thread = threadId) =>
        work.recordProviderEvent({
          ...eventBase(index),
          threadId: thread,
          type: "task.started",
          payload: { taskId: RuntimeTaskId.makeUnsafe(taskId), taskType: "local_agent" },
        });
      const complete = (index: number, taskId: string, thread = threadId) =>
        work.recordProviderEvent({
          ...eventBase(index),
          threadId: thread,
          type: "task.completed",
          payload: { taskId: RuntimeTaskId.makeUnsafe(taskId), status: "completed" },
        });
      const ids = (entries: ReadonlyArray<{ readonly workItemId: string }>) =>
        entries.map((entry) => entry.workItemId).toSorted();

      yield* start(1, "live");
      yield* start(2, "done-a");
      yield* complete(3, "done-a");
      yield* start(4, "done-b");
      yield* complete(5, "done-b");
      yield* start(6, "other-done", otherThreadId);
      yield* complete(7, "other-done", otherThreadId);

      assert.deepStrictEqual(ids((yield* work.getThreadSnapshot(threadId)).entries), [
        "done-a",
        "done-b",
        "live",
      ]);

      // Specific ids: the active one is ignored.
      const specific = yield* work.dismiss({ threadId, workItemIds: ["done-a", "live"] });
      assert.equal(specific.dismissedCount, 1);
      assert.deepStrictEqual(ids((yield* work.getThreadSnapshot(threadId)).entries), [
        "done-b",
        "live",
      ]);

      // Thread scope: other threads stay visible.
      const thread = yield* work.dismiss({ threadId });
      assert.equal(thread.dismissedCount, 1);
      assert.deepStrictEqual(ids((yield* work.getThreadSnapshot(threadId)).entries), ["live"]);
      assert.deepStrictEqual(ids((yield* work.getSnapshot).entries), ["live", "other-done"]);

      // Global scope.
      const global = yield* work.dismiss({});
      assert.equal(global.dismissedCount, 1);
      assert.deepStrictEqual(ids((yield* work.getSnapshot).entries), ["live"]);

      // A dismissed task that becomes active again reappears.
      yield* start(8, "done-a");
      assert.deepStrictEqual(ids((yield* work.getThreadSnapshot(threadId)).entries), [
        "done-a",
        "live",
      ]);
    }),
  );
});

it("persists distinct work identities for successive native task runs", () => {
  const first = transitionFromProviderEvent({
    ...eventBase(1),
    type: "task.started",
    payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), runId: "run-1", taskType: "local_bash" },
  });
  const second = transitionFromProviderEvent({
    ...eventBase(2),
    type: "task.started",
    payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), runId: "run-2", taskType: "local_bash" },
  });
  assert.equal(first?.workItemId, "task-1::run:run-1");
  assert.equal(second?.workItemId, "task-1::run:run-2");
});

it.effect(
  "persists each agent's effort through heartbeats and clears an unsupported model's effort",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* migrateBackgroundWork;
      const work = yield* ThreadBackgroundWork;
      const taskId = RuntimeTaskId.make("own-effort");
      yield* work.recordProviderEvent({
        ...eventBase(1),
        type: "task.started",
        payload: { taskId, taskType: "local_agent", model: "claude-sonnet-4-6", effort: "low" },
      });
      yield* work.recordProviderEvent({
        ...eventBase(2),
        type: "task.progress",
        payload: { taskId, description: "Still reviewing" },
      });
      const retained = (yield* work.getSnapshot).entries.find(
        (entry) => entry.workItemId === taskId,
      )!;
      assert.equal(retained.model, "claude-sonnet-4-6");
      assert.equal(retained.effort, "low");
      yield* work.recordProviderEvent({
        ...eventBase(3),
        type: "task.progress",
        payload: {
          taskId,
          description: "Actual model reported",
          model: "claude-haiku-4-5",
          effort: null,
        },
      });
      const updated = (yield* work.getSnapshot).entries.find(
        (entry) => entry.workItemId === taskId,
      )!;
      assert.equal(updated.model, "claude-haiku-4-5");
      assert.equal(updated.effort, null);
      const rows = yield* sql<{
        effort: string | null;
      }>`SELECT effort FROM projection_thread_background_work WHERE provider_work_item_id=${taskId}`;
      assert.deepStrictEqual(rows, [{ effort: null }]);
    }).pipe(Effect.provide(testLayer)),
);
