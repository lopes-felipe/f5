import { EventId, ProviderInstanceId, RuntimeTaskId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0066 from "../../persistence/Migrations/066_ThreadBackgroundWork.ts";
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
  listBindingsByProject: () => Effect.succeed([]),
};

const testLayer = ThreadBackgroundWorkLive.pipe(
  Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
  Layer.provideMerge(SqliteClient.layerMemory()),
);

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
      yield* Migration0066;
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

  it.effect("marks all active work terminal when its provider session exits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* Migration0066;
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

  it.effect("keeps inert work inactive when a progress event follows its start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* Migration0066;
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

  it.effect("bounds snapshots and periodically prunes persisted history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT OR REPLACE INTO projection_threads (thread_id) VALUES (${threadId})`;
      yield* Migration0066;
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
});
