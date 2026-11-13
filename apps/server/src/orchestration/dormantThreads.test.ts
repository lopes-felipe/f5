import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { referencedThreadIds, unloadedDormantThreadIds } from "./dormantThreads.ts";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";

type System = Awaited<ReturnType<typeof createPersistentOrchestrationSystem>>;

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("dormant-project");
const idle = ThreadId.makeUnsafe("archived-idle");
const neverStarted = ThreadId.makeUnsafe("archived-never-started");
const open = ThreadId.makeUnsafe("open");
const ready = ThreadId.makeUnsafe("archived-ready-session");
const midTurn = ThreadId.makeUnsafe("archived-turn-running");
const settingUp = ThreadId.makeUnsafe("archived-setup-running");
const all = [idle, neverStarted, open, ready, midTurn, settingUp];

// Activities without a sequence sort by creation time and then id, so ids here are chosen to
// sort in the order they are appended.
const appendActivity = (
  system: System,
  threadId: ThreadId,
  id: string,
  kind = "runtime.note",
  payload: unknown = {},
) =>
  system.run(
    system.engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`activity-${id}`),
      threadId,
      activity: {
        id: EventId.makeUnsafe(id),
        tone: "info",
        kind,
        summary: id,
        payload,
        turnId: null,
        createdAt,
      },
      createdAt,
    }),
  );

const setSession = (system: System, threadId: ThreadId, status: OrchestrationSession["status"]) =>
  system.run(
    system.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`session-${threadId}`),
      threadId,
      createdAt,
      session: {
        threadId,
        status,
        providerName: "codex",
        providerInstanceId: null,
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        lastErrorId: null,
        lastErrorOccurredAt: null,
        lastErrorRetryability: null,
        updatedAt: createdAt,
      },
    }),
  );

async function seed(system: System, directory: string) {
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("dormant-project"),
      projectId,
      title: "Project",
      workspaceRoot: directory,
      defaultModel: "gpt-5-codex",
      createdAt,
    }),
  );
  for (const threadId of all) {
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`create-${threadId}`),
        threadId,
        projectId,
        title: threadId,
        model: "gpt-5-codex",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await appendActivity(system, threadId, `first-${threadId}`);
  }
  await setSession(system, idle, "stopped");
  await setSession(system, open, "stopped");
  await setSession(system, ready, "ready");
  await setSession(system, midTurn, "stopped");
  await setSession(system, settingUp, "stopped");
  await appendActivity(system, settingUp, "setup", WORKTREE_SETUP_ACTIVITY_KIND, {
    phase: "running",
  });
  for (const threadId of all.filter((id) => id !== open))
    await system.run(
      system.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe(`archive-${threadId}`),
        threadId,
        createdAt,
      }),
    );
  // A turn the projection still shows as running, as after a crash mid-turn.
  await system.run(
    system.sql`
      INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
      VALUES (${midTurn}, 'turn-running', 'running', ${createdAt}, '[]')
    `,
  );
}

const activityIds = async (system: System, threadId: ThreadId) =>
  (await system.run(system.engine.getReadModel())).threads
    .find((thread) => thread.id === threadId)
    ?.activities.map((activity) => activity.id);

async function withRestartedSystem(run: (system: System) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-dormant-threads-"));
  const dbPath = path.join(directory, "state.sqlite");
  let system = await createPersistentOrchestrationSystem({ dbPath });
  try {
    await seed(system, directory);
    await system.dispose();
    system = await createPersistentOrchestrationSystem({ dbPath });
    await run(system);
  } finally {
    await system.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

afterEach(() => vi.unstubAllEnvs());

it("starts without the activities of archived idle threads only", () =>
  withRestartedSystem(async (system) => {
    expect(await activityIds(system, idle)).toEqual([]);
    expect(await activityIds(system, neverStarted)).toEqual([]);
    expect(await activityIds(system, open)).toEqual([`first-${open}`]);
    expect(await activityIds(system, ready)).toEqual([`first-${ready}`]);
    expect(await activityIds(system, midTurn)).toEqual([`first-${midTurn}`]);
    expect(await activityIds(system, settingUp)).toEqual([`first-${settingUp}`, "setup"]);

    // Recovery and other callers that do not ask for the reduced snapshot still get everything.
    const full = await system.run(system.snapshotQuery.getBootstrapSnapshot());
    expect(full.threads.find((thread) => thread.id === idle)?.activities).toHaveLength(1);
    const reduced = await system.run(
      system.snapshotQuery.getBootstrapSnapshot({ skipDormantThreadActivities: true }),
    );
    expect([...unloadedDormantThreadIds(reduced)].toSorted()).toEqual(
      [idle, neverStarted].toSorted(),
    );
  }));

it("loads a dormant thread before a command that names it is decided", () =>
  withRestartedSystem(async (system) => {
    await appendActivity(system, idle, "second");
    expect(await activityIds(system, idle)).toEqual([`first-${idle}`, "second"]);
    // The other dormant thread was not named and stays unloaded.
    expect(await activityIds(system, neverStarted)).toEqual([]);

    await system.run(
      system.engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("unarchive-never-started"),
        threadId: neverStarted,
        createdAt,
      }),
    );
    expect(await activityIds(system, neverStarted)).toEqual([`first-${neverStarted}`]);
  }));

it("loads dormant threads for readers that ask, once", () =>
  withRestartedSystem(async (system) => {
    await system.run(system.engine.loadThreadActivities!([idle, open]));
    expect(await activityIds(system, idle)).toEqual([`first-${idle}`]);
    expect(await activityIds(system, neverStarted)).toEqual([]);
    // A loaded thread is not read again: the read model is the same object.
    const loaded = await system.run(system.engine.getReadModel());
    await system.run(system.engine.loadThreadActivities!([idle, open]));
    expect(await system.run(system.engine.getReadModel())).toBe(loaded);
    await appendActivity(system, idle, "later");
    expect(await activityIds(system, idle)).toEqual([`first-${idle}`, "later"]);
  }));

it("loads every thread at startup when F5_EAGER_THREAD_ACTIVITIES=1", async () => {
  vi.stubEnv("F5_EAGER_THREAD_ACTIVITIES", "1");
  await withRestartedSystem(async (system) => {
    expect(await activityIds(system, idle)).toEqual([`first-${idle}`]);
    expect(await activityIds(system, neverStarted)).toEqual([`first-${neverStarted}`]);
  });
});

it("finds candidate ids anywhere in a command, as values or keys", () => {
  const candidates = new Set(["thread-a", "thread-b", "thread-c", "thread-d"]);
  expect(
    referencedThreadIds(
      {
        type: "thread.turn.start",
        threadId: "thread-x",
        sourceProposedPlan: { threadId: "thread-a", planId: "plan" },
        references: [{ threadId: "thread-b" }, null, 3],
        byThread: { "thread-c": true },
        text: `thread-d ${"x".repeat(200)}`,
      },
      candidates,
    ).toSorted(),
  ).toEqual(["thread-a", "thread-b", "thread-c"]);
  expect(referencedThreadIds("thread-d", candidates)).toEqual(["thread-d"]);
  expect(referencedThreadIds(undefined, candidates)).toEqual([]);
});
