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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coldThreadIdsOf,
  eventThreadId,
  isColdRetainedActivity,
  withThreadActivities,
} from "./coldThreadActivities.ts";
import { createEmptyReadModel } from "./projector.ts";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";

type System = Awaited<ReturnType<typeof createPersistentOrchestrationSystem>>;

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
  system = await createPersistentOrchestrationSystem({ dbPath });
};

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

const archiveEverythingButLive = async () => {
  await system.run(
    system.engine.dispatch({
      type: "thread.archive",
      commandId: command("archive"),
      threadId: archivedId,
      createdAt,
    }),
  );
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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-cold-activities-"));
  dbPath = path.join(directory, "state.sqlite");
  system = await createPersistentOrchestrationSystem({ dbPath });
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
      expect(cold.activities.map((activity) => activity.kind)).toEqual([
        WORKTREE_SETUP_ACTIVITY_KIND,
      ]);
      // Messages, plans and checkpoints are not part of the cold set.
      expect(cold.messages.map((message) => message.text)).toEqual(["answer"]);
    }

    // Callers that do not opt in still get every thread's activities.
    const full = await system.run(system.snapshotQuery.getBootstrapSnapshot());
    for (const id of threadIds)
      expect(thread(full, id).activities.map((activity) => activity.kind)).toEqual(allKinds);
    const omitted = await system.run(
      system.snapshotQuery.getBootstrapSnapshot({ omitArchivedActivities: true }),
    );
    expect(thread(omitted, liveId).activities).toEqual(thread(full, liveId).activities);
    expect(thread(omitted, archivedId).activities).toEqual(
      thread(full, archivedId).activities.filter(isColdRetainedActivity),
    );
  });

  it("loads a cold thread's activities when a command names it, and keeps them", async () => {
    await archiveEverythingButLive();
    await restart();
    const stored = await system.run(system.snapshotQuery.getRetainedThreadDetails!(archivedId));

    await appendActivity(archivedId, "late", "runtime.note");
    const warmed = await readThread(archivedId);
    expect(warmed.activities.slice(0, stored.activities.length)).toEqual(stored.activities);
    expect(warmed.activities.map((activity) => activity.kind)).toEqual([
      ...allKinds,
      "runtime.note",
    ]);
    expect(warmed.activities).toEqual(
      (await system.run(system.snapshotQuery.getRetainedThreadDetails!(archivedId))).activities,
    );

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
});

describe("cold thread helpers", () => {
  const model = (): OrchestrationReadModel => {
    const base = createEmptyReadModel(createdAt);
    const row = (id: string, archivedAt: string | null, deletedAt: string | null) =>
      ({ id: ThreadId.makeUnsafe(id), archivedAt, deletedAt, activities: [] }) as never;
    return {
      ...base,
      threads: [
        row("live", null, null),
        row("archived", createdAt, null),
        row("deleted", createdAt, createdAt),
      ],
    };
  };

  it("treats archived threads that are not deleted as cold", () => {
    expect([...coldThreadIdsOf(model())]).toEqual(["archived"]);
  });

  it("replaces activities only for the named threads", () => {
    const before = model();
    const activities = [{ kind: "runtime.note" }] as never;
    const after = withThreadActivities(
      before,
      new Map([[ThreadId.makeUnsafe("archived"), activities]]),
    );
    expect(after.threads[1]!.activities).toBe(activities);
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
