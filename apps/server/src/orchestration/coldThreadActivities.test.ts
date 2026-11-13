import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodeReviewWorkflowId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  coldThreadIdsOf,
  eventThreadId,
  isColdRetainedActivity,
  withThreadActivities,
} from "./coldThreadActivities.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel } from "./projector.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";

type System = Awaited<ReturnType<typeof createPersistentOrchestrationSystem>>;

// What the tests control about the engine's reads of a cold thread's activities.
const reads = {
  /** Threads whose activities were read, in order. */
  threadIds: [] as ThreadId[],
  fail: false,
  /** Each entry holds one read until its promise resolves. */
  gates: [] as Array<() => Promise<void>>,
  /** Replaces the bootstrap snapshot, to start from an older one. */
  bootstrap: null as OrchestrationReadModel | null,
};

/** Holds the next read of a cold thread's activities until `open` is called. */
const blockNextRead = () => {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  reads.gates.push(() => {
    reached();
    return opened;
  });
  return { waiting, open };
};

const snapshotQueryLayer = Layer.effect(
  ProjectionSnapshotQuery,
  Effect.gen(function* () {
    const live = yield* ProjectionSnapshotQuery;
    return {
      ...live,
      getBootstrapSnapshot: (options) =>
        reads.bootstrap ? Effect.succeed(reads.bootstrap) : live.getBootstrapSnapshot(options),
      getRetainedThreadActivities: (threadId) =>
        Effect.gen(function* () {
          reads.threadIds.push(threadId);
          const gate = reads.gates.shift();
          if (gate) yield* Effect.promise(gate);
          if (reads.fail)
            return yield* new PersistenceSqlError({ operation: "test", detail: "read failed" });
          return yield* live.getRetainedThreadActivities!(threadId);
        }),
    } satisfies typeof live;
  }),
).pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive));

const createSystem = (dbPath: string) =>
  createPersistentOrchestrationSystem({ dbPath, projectionSnapshotQueryLayer: snapshotQueryLayer });

const createdAt = "2026-11-01T10:00:00.000Z";
const projectId = ProjectId.makeUnsafe("cold-project");
const liveId = ThreadId.makeUnsafe("cold-live");
const archivedId = ThreadId.makeUnsafe("cold-archived");
const reviewerA = ThreadId.makeUnsafe("cold-reviewer-a");
const reviewerB = ThreadId.makeUnsafe("cold-reviewer-b");
const workflowId = CodeReviewWorkflowId.makeUnsafe("cold-workflow");
const threadIds = [liveId, archivedId, reviewerA, reviewerB];

let directory: string;
let dbPath: string;
let system: System;

const command = (name: string) => CommandId.makeUnsafe(`cold-${name}`);

const thread = (model: OrchestrationReadModel, id: ThreadId) =>
  model.threads.find((entry) => entry.id === id)!;

const readThread = async (id: ThreadId) =>
  thread(await system.run(system.engine.getReadModel()), id);

const activityKinds = async (id: ThreadId) =>
  (await readThread(id)).activities.map((activity) => activity.kind);

// Activities sort by time, so each one gets a later timestamp than the last.
let tick = 0;
const appendActivity = (id: ThreadId, name: string, kind: string) => {
  const at = new Date(Date.parse(createdAt) + ++tick * 1000).toISOString();
  return system.run(
    system.engine.dispatch({
      type: "thread.activity.append",
      commandId: command(`${name}-${id}`),
      threadId: id,
      activity: {
        id: EventId.makeUnsafe(`${name}:${id}`),
        tone: "info",
        kind,
        summary: name,
        payload: { name },
        turnId: null,
        createdAt: at,
      },
      createdAt: at,
    }),
  );
};

const restart = async () => {
  await system.dispose();
  system = await createSystem(dbPath);
};

const storedActivities = async (id: ThreadId) =>
  (await system.run(system.snapshotQuery.getRetainedThreadDetails!(id))).activities;

/** A project, four threads with history, and a code-review workflow over two of them. */
const seed = async () => {
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: command("project"),
      projectId,
      title: "Project",
      workspaceRoot: directory,
      defaultModel: "gpt-5-codex",
      createdAt,
    }),
  );
  for (const id of threadIds) {
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: command(`create-${id}`),
        threadId: id,
        projectId,
        title: id,
        model: "gpt-5-codex",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: command(`delta-${id}`),
        threadId: id,
        messageId: MessageId.makeUnsafe(`message:${id}`),
        delta: "answer",
        createdAt,
      }),
    );
    await appendActivity(id, "setup", WORKTREE_SETUP_ACTIVITY_KIND);
    await appendActivity(id, "note", "runtime.note");
    await appendActivity(id, "tool", "tool.completed");
  }
  const slot = { provider: "codex" as const, model: "gpt-5-codex" };
  await system.run(
    system.engine.dispatch({
      type: "project.code-review-workflow.create",
      commandId: command("workflow"),
      workflowId,
      projectId,
      title: "Review",
      slug: "review",
      reviewPrompt: "Review",
      templateId: "builtin.code-review.dual",
      templateVersion: 1,
      branch: null,
      reviewerA: slot,
      reviewerB: slot,
      consolidation: slot,
      reviewerThreadIdA: reviewerA,
      reviewerThreadIdB: reviewerB,
      createdAt,
    }),
  );
};

const archiveThread = () =>
  system.run(
    system.engine.dispatch({
      type: "thread.archive",
      commandId: command("archive"),
      threadId: archivedId,
      createdAt,
    }),
  );

const archiveEverythingButLive = async () => {
  await archiveThread();
  await system.run(
    system.engine.dispatch({
      type: "project.workflow.archive",
      commandId: command("workflow-archive"),
      projectId,
      workflowKind: "codeReview",
      workflowId,
      createdAt,
    }),
  );
};

const allKinds = [WORKTREE_SETUP_ACTIVITY_KIND, "runtime.note", "tool.completed"];

beforeEach(async () => {
  tick = 0;
  Object.assign(reads, { threadIds: [], fail: false, gates: [], bootstrap: null });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-cold-activities-"));
  dbPath = path.join(directory, "state.sqlite");
  system = await createSystem(dbPath);
  await seed();
});

afterEach(async () => {
  await system.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("cold thread activities", () => {
  it("keeps a thread archived during this run fully loaded", async () => {
    await archiveEverythingButLive();
    for (const id of threadIds) expect(await activityKinds(id)).toEqual(allKinds);
  });

  it("starts archived threads with their worktree-setup activity only", async () => {
    await archiveEverythingButLive();
    await restart();

    expect(await activityKinds(liveId)).toEqual(allKinds);
    for (const id of [archivedId, reviewerA, reviewerB]) {
      const cold = await readThread(id);
      expect(cold.archivedAt).not.toBeNull();
      // The flag tells a cold thread from one with no history.
      expect(cold.activitiesOmitted).toBe(true);
      expect(cold.activities.map((activity) => activity.kind)).toEqual([
        WORKTREE_SETUP_ACTIVITY_KIND,
      ]);
      // Messages, plans and checkpoints are not part of the cold set.
      expect(cold.messages.map((message) => message.text)).toEqual(["answer"]);
    }

    expect((await readThread(liveId)).activitiesOmitted).toBeUndefined();

    // Callers that do not opt in still get every thread's activities.
    const full = await system.run(system.snapshotQuery.getBootstrapSnapshot());
    for (const id of threadIds) {
      expect(thread(full, id).activities.map((activity) => activity.kind)).toEqual(allKinds);
      expect(thread(full, id).activitiesOmitted).toBeUndefined();
    }
    const omitted = await system.run(
      system.snapshotQuery.getBootstrapSnapshot({ omitArchivedActivities: true }),
    );
    expect(thread(omitted, liveId).activities).toEqual(thread(full, liveId).activities);
    expect(thread(omitted, archivedId).activities).toEqual(
      thread(full, archivedId).activities.filter(isColdRetainedActivity),
    );
  });

  it("loads a cold thread's activities when a command reaches it, and keeps them", async () => {
    await archiveEverythingButLive();
    await restart();
    const stored = await storedActivities(archivedId);

    await appendActivity(archivedId, "late", "runtime.note");
    const warmed = await readThread(archivedId);
    expect(warmed.activitiesOmitted).toBeUndefined();
    expect(warmed.activities.slice(0, stored.length)).toEqual(stored);
    expect(warmed.activities.map((activity) => activity.kind)).toEqual([
      ...allKinds,
      "runtime.note",
    ]);
    expect(warmed.activities).toEqual(await storedActivities(archivedId));
    // One read, after the commit; the decision does not wait for one.
    expect(reads.threadIds).toEqual([archivedId]);

    // Still archived, and no longer cold: a command on another thread leaves it loaded.
    await appendActivity(liveId, "other", "runtime.note");
    expect((await readThread(archivedId)).activities).toEqual(warmed.activities);
    // The workflow's threads were not named and stay cold.
    expect(await activityKinds(reviewerA)).toEqual([WORKTREE_SETUP_ACTIVITY_KIND]);
  });

  it("loads activities when a thread is unarchived", async () => {
    await archiveEverythingButLive();
    await restart();
    await system.run(
      system.engine.dispatch({
        type: "thread.unarchive",
        commandId: command("unarchive"),
        threadId: archivedId,
        createdAt,
      }),
    );
    const restored = await readThread(archivedId);
    expect(restored.archivedAt).toBeNull();
    expect(restored.activities.map((activity) => activity.kind)).toEqual(allKinds);
  });

  it("loads activities for threads an event reaches without a command naming them", async () => {
    await archiveEverythingButLive();
    await restart();
    await system.run(
      system.engine.dispatch({
        type: "project.workflow.unarchive",
        commandId: command("workflow-unarchive"),
        projectId,
        workflowKind: "codeReview",
        workflowId,
        createdAt,
      }),
    );
    for (const id of [reviewerA, reviewerB]) {
      const restored = await readThread(id);
      expect(restored.archivedAt).toBeNull();
      expect(restored.activities).toEqual(
        (await system.run(system.snapshotQuery.getRetainedThreadDetails!(id))).activities,
      );
      expect(restored.activities.map((activity) => activity.kind)).toEqual(allKinds);
    }
    expect(await activityKinds(archivedId)).toEqual([WORKTREE_SETUP_ACTIVITY_KIND]);
  });

  it("loads activities on request without a command", async () => {
    await archiveEverythingButLive();
    await restart();
    const before = await system.run(system.engine.getReadModel());
    await system.run(system.engine.ensureThreadActivities!([archivedId, liveId]));
    const after = await system.run(system.engine.getReadModel());
    expect(after.snapshotSequence).toBe(before.snapshotSequence);
    expect(thread(after, archivedId).activities.map((activity) => activity.kind)).toEqual(allKinds);
    // Threads that were not requested keep their identity.
    expect(thread(after, liveId)).toBe(thread(before, liveId));
    expect(thread(after, reviewerA)).toBe(thread(before, reviewerA));
    // A second request is a no-op.
    await system.run(system.engine.ensureThreadActivities!([archivedId]));
    expect(await system.run(system.engine.getReadModel())).toBe(after);
  });

  it("keeps commands in order with an on-demand load", async () => {
    await archiveEverythingButLive();
    await restart();
    await Promise.all([
      appendActivity(archivedId, "racing", "runtime.note"),
      system.run(system.engine.ensureThreadActivities!([archivedId])),
      appendActivity(liveId, "racing", "runtime.note"),
    ]);
    expect((await readThread(archivedId)).activities).toEqual(
      (await system.run(system.snapshotQuery.getRetainedThreadDetails!(archivedId))).activities,
    );
    expect(await activityKinds(archivedId)).toEqual([...allKinds, "runtime.note"]);
  });

  it("does not hold commands up during a load, and no command overwrites it", async () => {
    // One cold thread and no deleted thread: once it loads, nothing is cold, and
    // a command that read the model before the load would publish it unchanged.
    await archiveThread();
    await restart();
    const first = blockNextRead();
    const second = blockNextRead();

    const load = system.run(system.engine.ensureThreadActivities!([archivedId]));
    await first.waiting;
    // The read is outside the engine's write permit, so this command completes.
    await appendActivity(liveId, "during", "runtime.note");
    first.open();
    // A commit happened meanwhile, so the load reads again, now under the permit.
    await second.waiting;
    const queued = appendActivity(liveId, "queued", "runtime.note");
    // Let the engine take the queued command before the load finishes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    second.open();
    await Promise.all([load, queued]);

    const loaded = await readThread(archivedId);
    expect(loaded.activitiesOmitted).toBeUndefined();
    expect(loaded.activities).toEqual(await storedActivities(archivedId));
    expect(loaded.activities.map((activity) => activity.kind)).toEqual(allKinds);
    expect(reads.threadIds).toEqual([archivedId, archivedId]);
    expect(await activityKinds(liveId)).toEqual([...allKinds, "runtime.note", "runtime.note"]);
  });

  it("leaves a thread cold when its load fails, and the next touch loads it", async () => {
    await archiveEverythingButLive();
    await restart();
    reads.fail = true;

    // After a commit: the command itself succeeds.
    await appendActivity(archivedId, "late", "runtime.note");
    const afterCommit = await readThread(archivedId);
    expect(afterCommit.activitiesOmitted).toBe(true);
    expect(afterCommit.activities.map((activity) => activity.kind)).toEqual([
      WORKTREE_SETUP_ACTIVITY_KIND,
      "runtime.note",
    ]);

    // On request: the failure is logged, not raised.
    await system.run(system.engine.ensureThreadActivities!([archivedId, reviewerA]));
    expect((await readThread(archivedId)).activitiesOmitted).toBe(true);
    expect((await readThread(reviewerA)).activitiesOmitted).toBe(true);

    reads.fail = false;
    // A command on another thread does not retry it.
    await appendActivity(liveId, "other", "runtime.note");
    expect((await readThread(archivedId)).activitiesOmitted).toBe(true);
    // The next event on the thread does.
    await appendActivity(archivedId, "later", "runtime.note");
    const loaded = await readThread(archivedId);
    expect(loaded.activitiesOmitted).toBeUndefined();
    expect(loaded.activities).toEqual(await storedActivities(archivedId));
    expect(loaded.activities.map((activity) => activity.kind)).toEqual([
      ...allKinds,
      "runtime.note",
      "runtime.note",
    ]);
    // So does a request.
    await system.run(system.engine.ensureThreadActivities!([reviewerA]));
    expect(await activityKinds(reviewerA)).toEqual(allKinds);
  });

  it("loads a cold thread when startup replays an event for it", async () => {
    await archiveEverythingButLive();
    await restart();
    // Start the next run from this snapshot; the event below comes after it.
    const earlier = await system.run(
      system.snapshotQuery.getBootstrapSnapshot({ omitArchivedActivities: true }),
    );
    await appendActivity(archivedId, "late", "runtime.note");
    reads.bootstrap = earlier;
    reads.threadIds = [];
    await restart();

    const replayed = await readThread(archivedId);
    expect(replayed.activitiesOmitted).toBeUndefined();
    expect(replayed.activities).toEqual(await storedActivities(archivedId));
    expect(replayed.activities.map((activity) => activity.kind)).toEqual([
      ...allKinds,
      "runtime.note",
    ]);
    expect(reads.threadIds).toEqual([archivedId]);
    expect((await readThread(reviewerA)).activitiesOmitted).toBe(true);

    // The same replay with a failing read: the event is applied and the thread stays cold.
    reads.fail = true;
    await restart();
    const unloaded = await readThread(archivedId);
    expect(unloaded.activitiesOmitted).toBe(true);
    expect(unloaded.activities.map((activity) => activity.kind)).toEqual([
      WORKTREE_SETUP_ACTIVITY_KIND,
      "runtime.note",
    ]);
    reads.fail = false;
    await system.run(system.engine.ensureThreadActivities!([archivedId]));
    expect((await readThread(archivedId)).activities).toEqual(await storedActivities(archivedId));
  });

  it("deletes a cold thread without reading its activities", async () => {
    await archiveEverythingButLive();
    await restart();
    await system.run(
      system.engine.dispatch({
        type: "thread.delete",
        commandId: command("delete"),
        threadId: archivedId,
      }),
    );
    const deleted = await readThread(archivedId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.activities).toEqual([]);
    expect(deleted.activitiesOmitted).toBeUndefined();
    expect(reads.threadIds).toEqual([]);
    // Nothing is left to load for it.
    await system.run(system.engine.ensureThreadActivities!([archivedId]));
    expect(reads.threadIds).toEqual([]);

    // With a deleted thread in the model, other cold threads still load.
    await appendActivity(reviewerA, "late", "runtime.note");
    const loaded = await readThread(reviewerA);
    expect(loaded.activitiesOmitted).toBeUndefined();
    expect(loaded.activities).toEqual(await storedActivities(reviewerA));
    expect(reads.threadIds).toEqual([reviewerA]);

    // A deleted thread does not start cold.
    await restart();
    expect((await readThread(archivedId)).activitiesOmitted).toBeUndefined();
    expect((await readThread(reviewerB)).activitiesOmitted).toBe(true);
  });
});

describe("cold thread helpers", () => {
  const model = (): OrchestrationReadModel => {
    const base = createEmptyReadModel(createdAt);
    const row = (id: string, archivedAt: string | null, omitted: boolean) =>
      ({
        id: ThreadId.makeUnsafe(id),
        archivedAt,
        deletedAt: null,
        activities: [],
        ...(omitted ? { activitiesOmitted: true } : {}),
      }) as never;
    return {
      ...base,
      threads: [
        row("live", null, false),
        row("archived", createdAt, true),
        row("archived-loaded", createdAt, false),
      ],
    };
  };

  it("treats threads flagged activitiesOmitted as cold", () => {
    expect([...coldThreadIdsOf(model())]).toEqual(["archived"]);
  });

  it("replaces activities only for the named threads and clears their flag", () => {
    const before = model();
    const activities = [{ kind: "runtime.note" }] as never;
    const after = withThreadActivities(
      before,
      new Map([[ThreadId.makeUnsafe("archived"), activities]]),
    );
    expect(after.threads[1]!.activities).toBe(activities);
    expect("activitiesOmitted" in after.threads[1]!).toBe(false);
    expect(after.threads[0]).toBe(before.threads[0]);
    expect(withThreadActivities(before, new Map())).toBe(before);
    expect(
      withThreadActivities(before, new Map([[ThreadId.makeUnsafe("missing"), activities]])),
    ).toBe(before);
  });

  it("reads the thread of thread events only", () => {
    expect(eventThreadId({ aggregateKind: "thread", aggregateId: liveId })).toBe(liveId);
    expect(eventThreadId({ aggregateKind: "project", aggregateId: projectId })).toBeNull();
  });
});
