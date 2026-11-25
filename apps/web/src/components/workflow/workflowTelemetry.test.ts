import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import {
  computeWorkflowRunTelemetry,
  formatCompactTokenCount,
  resolveStepDuration,
} from "./workflowTelemetry";
import type { WorkflowTimelinePhase, WorkflowTimelineStep } from "./workflowTimelineTypes";

function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe(id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: `Thread ${id}`,
    model: "gpt-5.4",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:30.000Z",
      orchestrationStatus: "ready",
    },
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    error: null,
    createdAt: "2026-04-24T12:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-04-24T12:00:30.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowTimelineStep>): WorkflowTimelineStep {
  return {
    key: "step-a",
    label: "Branch A",
    threadId: ThreadId.makeUnsafe("thread-a"),
    state: "completed",
    modelSlot: null,
    ...overrides,
  };
}

describe("workflowTelemetry", () => {
  it("formats compact token counts across scales", () => {
    expect(formatCompactTokenCount(0)).toBe("0 tok");
    expect(formatCompactTokenCount(850)).toBe("850 tok");
    expect(formatCompactTokenCount(12_460)).toBe("12.5k tok");
    expect(formatCompactTokenCount(142_000)).toBe("142k tok");
    expect(formatCompactTokenCount(1_250_000)).toBe("1.3M tok");
  });

  it("computes live elapsed time for active steps and settled time for completed steps", () => {
    const activeThread = makeThread("thread-active", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const activeDuration = resolveStepDuration(
      makeStep({ state: "active", threadId: activeThread.id }),
      activeThread,
      "2026-04-24T12:01:15.000Z",
    );
    expect(activeDuration?.durationMs).toBe(75_000);
    expect(activeDuration?.elapsedLabel).toBe("1m 15s");

    const completedThread = makeThread("thread-done", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:12.000Z",
        assistantMessageId: null,
      },
    });
    const settledDuration = resolveStepDuration(
      makeStep({ state: "completed", threadId: completedThread.id }),
      completedThread,
      "2026-04-24T12:05:00.000Z",
    );
    expect(settledDuration?.durationMs).toBe(12_000);
    expect(settledDuration?.elapsedLabel).toBe("12s");
  });

  it("identifies a bottleneck in a parallel phase and deduplicates shared thread tokens", () => {
    const fastThread = makeThread("thread-a", {
      estimatedContextTokens: 12_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-a"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:10.000Z",
        assistantMessageId: null,
      },
    });
    const slowThread = makeThread("thread-b", {
      estimatedContextTokens: 28_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-b"),
        state: "running",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    const phases: WorkflowTimelinePhase[] = [
      {
        id: "authoring",
        label: "Drafting",
        state: "active",
        steps: [
          makeStep({
            key: "author-a",
            label: "Branch A",
            threadId: fastThread.id,
            state: "completed",
          }),
          makeStep({
            key: "author-b",
            label: "Branch B",
            threadId: slowThread.id,
            state: "active",
          }),
        ],
      },
      {
        id: "revisions",
        label: "Revisions",
        state: "pending",
        steps: [
          // Reuses fastThread in a later phase: must not double-count tokens.
          makeStep({ key: "rev-a", label: "Revise A", threadId: fastThread.id, state: "pending" }),
        ],
      },
    ];

    const threadById = new Map<Thread["id"], Thread>([
      [fastThread.id, fastThread],
      [slowThread.id, slowThread],
    ]);

    const telemetry = computeWorkflowRunTelemetry({
      phases,
      threadById,
      overallState: "active",
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:10.000Z",
      nowIso: "2026-04-24T12:01:00.000Z",
    });

    expect(telemetry.completedSteps).toBe(1);
    expect(telemetry.activeSteps).toBe(1);
    expect(telemetry.totalSteps).toBe(3);
    expect(telemetry.totalContextTokens).toBe(40_000);
    expect(telemetry.totalElapsedLabel).toBe("1m");
    expect(telemetry.slowestStep?.label).toBe("Branch B");
    expect(telemetry.stepTelemetryByKey.get("author-b")?.isBottleneck).toBe(true);
    expect(telemetry.stepTelemetryByKey.get("author-a")?.isBottleneck).toBe(false);
  });

  it("does not flag a bottleneck when parallel steps have similar durations", () => {
    const threadA = makeThread("thread-a", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-a"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:10.000Z",
        assistantMessageId: null,
      },
    });
    const threadB = makeThread("thread-b", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-b"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:12.000Z",
        assistantMessageId: null,
      },
    });

    const telemetry = computeWorkflowRunTelemetry({
      phases: [
        {
          id: "review",
          label: "Review",
          state: "completed",
          steps: [
            makeStep({
              key: "rev-a",
              label: "Reviewer A",
              threadId: threadA.id,
              state: "completed",
            }),
            makeStep({
              key: "rev-b",
              label: "Reviewer B",
              threadId: threadB.id,
              state: "completed",
            }),
          ],
        },
      ],
      threadById: new Map([
        [threadA.id, threadA],
        [threadB.id, threadB],
      ]),
      overallState: "completed",
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:12.000Z",
      nowIso: "2026-04-24T12:05:00.000Z",
    });

    expect(telemetry.stepTelemetryByKey.get("rev-a")?.isBottleneck).toBe(false);
    expect(telemetry.stepTelemetryByKey.get("rev-b")?.isBottleneck).toBe(false);
  });
});
