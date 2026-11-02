import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  compareRecoveredReadModel,
  decodeRecoverySnapshot,
  readModelToRecoveryEvents,
  rebuildFromSnapshot,
} from "./SnapshotRecovery.ts";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T11:00:00.000Z";
const T2 = "2026-10-01T12:00:00.000Z";

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: T0,
    lastInteractionAt: T1,
    updatedAt: T1,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function message(id: string, role: "user" | "assistant", createdAt: string) {
  return {
    id,
    role,
    text: `text ${id}`,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function workflow() {
  const branch = (branchId: "a" | "b", authorThreadId: string) => ({
    branchId,
    authorSlot: { provider: "codex", model: "gpt-5-codex" },
    authorThreadId,
    planFilePath: null,
    planTurnId: null,
    revisionTurnId: null,
    reviews: [],
    status: "revised",
    error: null,
    errorStage: null,
    retryCount: 0,
    lastRetryAt: null,
    updatedAt: T1,
  });
  return {
    id: "workflow-1",
    projectId: "project-1",
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the plan",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: branch("a", "author-a"),
    branchB: branch("b", "author-b"),
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      outputFilePath: null,
      turnId: null,
      approvedPlanId: null,
      status: "not_started",
      error: null,
      updatedAt: T1,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: T0,
    updatedAt: T1,
    archivedAt: null,
    deletedAt: null,
  };
}

const snapshot = decodeRecoverySnapshot({
  id: "export-1",
  result: {
    snapshotSequence: 1234,
    pinRevision: 3,
    projects: [
      {
        id: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModel: null,
        scripts: [],
        createdAt: T0,
        updatedAt: T0,
        deletedAt: null,
      },
      {
        id: "project-gone",
        title: "Gone",
        workspaceRoot: "/tmp/project-gone",
        defaultModel: null,
        scripts: [],
        createdAt: T0,
        updatedAt: T0,
        deletedAt: T2,
      },
    ],
    threads: [
      thread("thread-live", {
        messages: [message("m1", "user", T0), message("m2", "assistant", T1)],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "# Plan",
            createdAt: T1,
            updatedAt: T1,
          },
        ],
        activities: [
          {
            id: "activity-1",
            tone: "info",
            kind: "note",
            summary: "Something happened",
            payload: {},
            turnId: null,
            createdAt: T1,
          },
        ],
        session: {
          threadId: "thread-live",
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: T1,
        },
        pinnedAt: T1,
        pinOrderKey: 0,
      }),
      thread("thread-archived", { archivedAt: T2, messages: [message("m3", "user", T0)] }),
      thread("thread-deleted", { deletedAt: T2 }),
      thread("author-a"),
      thread("author-b"),
    ],
    planningWorkflows: [workflow()],
    updatedAt: T2,
  },
});

const layer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-snapshot-recovery-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("rebuilds a database whose snapshot matches the exported read model", () =>
  Effect.gen(function* () {
    const report = yield* rebuildFromSnapshot(snapshot);
    assert.equal(report.integrity, "ok");
    assert.deepEqual(report.mismatches, []);

    const restored = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
    const live = restored.threads.find((entry) => entry.id === "thread-live");
    assert.equal(live?.session?.status, "stopped");
    assert.equal(live?.session?.activeTurnId, null);
    assert.equal(live?.proposedPlans[0]?.planMarkdown, "# Plan");
    assert.deepEqual(
      live?.messages.map((entry) => entry.id),
      ["m1", "m2"],
    );
    assert.isNotNull(restored.projects.find((entry) => entry.id === "project-gone")?.deletedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses to recover into a database that already has events", () =>
  Effect.gen(function* () {
    yield* rebuildFromSnapshot(snapshot);
    const exit = yield* Effect.exit(rebuildFromSnapshot(snapshot));
    assert.equal(exit._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it("derives the same event IDs from the same snapshot", () => {
  const first = readModelToRecoveryEvents(snapshot).map((event) => event.eventId);
  const second = readModelToRecoveryEvents(snapshot).map((event) => event.eventId);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
});

it("reports missing threads and changed message counts", () => {
  const damaged = {
    ...snapshot,
    threads: snapshot.threads
      .filter((entry) => entry.id !== "thread-archived")
      .map((entry) => (entry.id === "thread-live" ? { ...entry, messages: [] } : entry)),
  };
  const fields = compareRecoveredReadModel(snapshot, damaged).map(
    (mismatch) => `${mismatch.entity}:${mismatch.field}`,
  );
  assert.includeMembers(fields, [
    "model:threads",
    "thread thread-archived:present",
    "thread thread-live:messages",
  ]);
});
