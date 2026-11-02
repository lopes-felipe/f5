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
const T1_30 = "2026-10-01T11:30:00.000Z";

const tracking = {
  version: 1,
  source: "claude-task-tools",
  nativeSessionId: "native-1",
  generation: 3,
  syncState: "synced",
  pendingCalls: [],
  invalidatedCallIds: [],
  handledCallIds: ["call-1", "call-2"],
  provenance: [],
  suppressedTaskIds: ["task-gone"],
} as const;

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

function message(
  id: string,
  role: "user" | "assistant",
  createdAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    role,
    text: `text ${id}`,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
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
        memories: [
          {
            id: "memory-1",
            projectId: "project-1",
            scope: "project",
            type: "feedback",
            name: "Run tests",
            description: "How to run tests",
            body: "Use bun run test.",
            createdAt: T0,
            updatedAt: T0,
          },
        ],
        skills: [
          {
            id: "skill-1",
            projectId: "project-1",
            scope: "project",
            commandName: "deploy",
            description: "Deploy the app",
            updatedAt: T0,
          },
        ],
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
        messages: [
          message("m1", "user", T0, { turnId: "turn-1" }),
          message("m2", "assistant", T1, { turnId: "turn-1", reasoningTokens: 42 }),
        ],
        checkpoints: [
          {
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/f5/checkpoints/thread-live/1",
            status: "ready",
            files: [],
            assistantMessageId: "m2",
            completedAt: T1,
          },
        ],
        // The latest turn was interrupted before it captured a checkpoint.
        latestTurn: {
          turnId: "turn-2",
          state: "interrupted",
          requestedAt: T1,
          startedAt: T1,
          completedAt: T1_30,
          processingQuiescedAt: T1_30,
          assistantMessageId: null,
        },
        // Older than the messages: replaying it last would move the thread back.
        tasks: [{ id: "task-1", content: "Ship it", activeForm: "Shipping it", status: "pending" }],
        tasksTurnId: "turn-1",
        tasksUpdatedAt: T0,
        sessionNotes: {
          title: "Live thread",
          currentState: "Working",
          taskSpecification: "Ship it",
          filesAndFunctions: "",
          workflow: "",
          errorsAndCorrections: "",
          codebaseAndSystemDocumentation: "",
          learnings: "",
          keyResults: "",
          worklog: "",
          updatedAt: T1,
          sourceLastInteractionAt: T1,
        },
        compaction: {
          summary: "Earlier work",
          trigger: "manual",
          estimatedTokens: 10,
          modelContextWindowTokens: 1000,
          createdAt: T1,
        },
        titleState: { needsRefinement: true, refinementCount: 1, lastRefinedTurn: 1 },
        lastInteractionAt: T1_30,
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
          activeTurnId: "turn-2",
          lastError: null,
          updatedAt: T1,
        },
        pinnedAt: T1,
        pinOrderKey: 0,
      }),
      thread("thread-archived", { archivedAt: T2, messages: [message("m3", "user", T0)] }),
      thread("thread-settled", {
        settledAt: T2,
        settledBy: "user",
        autoSettleDisabled: true,
        // An emptied list still carries its tracking state.
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: T1,
        tasksTracking: tracking,
        pinnedAt: T0,
        pinOrderKey: 1,
      }),
      // Snoozing unpins, so a snoozed thread is never also pinned.
      thread("thread-snoozed", { snoozedUntil: "2026-10-05T09:00:00.000Z", snoozedAt: T2 }),
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

it.effect("restores the latest turn, task tracking, title state and per-pin times", () =>
  Effect.gen(function* () {
    yield* rebuildFromSnapshot(snapshot);
    const restored = yield* (yield* ProjectionSnapshotQuery).getBootstrapSnapshot();
    const live = restored.threads.find((entry) => entry.id === "thread-live")!;
    assert.equal(live.latestTurn?.turnId, "turn-2");
    assert.equal(live.latestTurn?.state, "interrupted");
    assert.equal(live.lastInteractionAt, T1_30);
    assert.deepEqual(live.titleState, {
      needsRefinement: true,
      refinementCount: 1,
      lastRefinedTurn: 1,
    });
    assert.equal(live.messages[1]?.reasoningTokens, 42);
    const settled = restored.threads.find((entry) => entry.id === "thread-settled")!;
    assert.deepEqual(settled.tasksTracking, tracking);
    assert.equal(settled.pinnedAt, T0);
    assert.equal(live.pinnedAt, T1);
  }).pipe(Effect.provide(layer)),
);

it("reports same-count content changes, not just count changes", () => {
  const live = snapshot.threads.find((entry) => entry.id === "thread-live")!;
  const settled = snapshot.threads.find((entry) => entry.id === "thread-settled")!;
  const changed = {
    ...snapshot,
    threads: snapshot.threads.map((entry) =>
      entry === live
        ? {
            ...live,
            messages: live.messages.map((item, index) =>
              index === 0 ? { ...item, text: "edited" } : item,
            ),
            activities: live.activities.map((item) => ({ ...item, createdAt: T0 })),
            latestTurn: null,
          }
        : entry === settled
          ? { ...settled, tasksTracking: { ...tracking, generation: 0 } }
          : entry,
    ),
  };
  const fields = compareRecoveredReadModel(snapshot, changed).map(
    (mismatch) => `${mismatch.entity}:${mismatch.field}`,
  );
  assert.includeMembers(fields, [
    "thread thread-live:messages[0]",
    "thread thread-live:activities[0]",
    "thread thread-live:latestTurn",
    "thread thread-settled:tasksTracking",
  ]);
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
    "thread thread-live:messages.length",
  ]);
});
