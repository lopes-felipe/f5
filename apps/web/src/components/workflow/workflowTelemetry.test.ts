import { ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import { computeWorkflowRunTelemetry, resolveStepTiming } from "./workflowTelemetry";
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
  it("resolves live timing for active running turns and settled timing for completed turns", () => {
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
    const activeTiming = resolveStepTiming(
      makeStep({ state: "active", threadId: activeThread.id }),
      activeThread,
    );
    expect(activeTiming).toEqual({
      startIso: "2026-04-24T12:00:00.000Z",
      endIso: null,
      isLive: true,
      durationMs: null,
      elapsedLabel: null,
    });

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
    const settledTiming = resolveStepTiming(
      makeStep({ state: "completed", threadId: completedThread.id, turnId: "turn-2" }),
      completedThread,
    );
    expect(settledTiming?.durationMs).toBe(12_000);
    expect(settledTiming?.elapsedLabel).toBe("12s");
    expect(settledTiming?.isLive).toBe(false);

    // Settled step without completedAt returns null instead of falling back to mutable timestamps.
    const incompleteThread = makeThread("thread-missing-end", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-3"),
        state: "running",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    expect(
      resolveStepTiming(
        makeStep({ state: "completed", threadId: incompleteThread.id }),
        incompleteThread,
      ),
    ).toBeNull();
  });

  it("isolates turn timings when a single thread is shared across Authoring and Revision", () => {
    const sharedThreadId = ThreadId.makeUnsafe("thread-shared");

    // 1. Authoring finished ("turn-plan": 10s), Revision is active but has not dispatched its turn yet.
    const afterAuthoringThread = makeThread("thread-shared", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-plan"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:10.000Z",
        assistantMessageId: null,
      },
    });
    const phasesBeforeRevTurn: WorkflowTimelinePhase[] = [
      {
        id: "authoring",
        label: "Authoring",
        state: "completed",
        parallel: true,
        steps: [
          makeStep({
            key: "author-a",
            label: "Branch A",
            threadId: sharedThreadId,
            turnId: "turn-plan",
            state: "completed",
          }),
        ],
      },
      {
        id: "revision",
        label: "Revision",
        state: "active",
        parallel: true,
        steps: [
          makeStep({
            key: "rev-a",
            label: "Branch A",
            threadId: sharedThreadId,
            turnId: null,
            state: "active",
          }),
        ],
      },
    ];
    const beforeRevTelemetry = computeWorkflowRunTelemetry({
      phases: phasesBeforeRevTurn,
      threadById: new Map([[sharedThreadId, afterAuthoringThread]]),
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:15.000Z",
    });
    expect(beforeRevTelemetry.stepTelemetryByKey.get("author-a")?.elapsedLabel).toBe("10s");
    // Revision must NOT read Authoring's completed turn requestedAt.
    expect(beforeRevTelemetry.stepTelemetryByKey.get("rev-a")?.isLive).toBe(false);
    expect(beforeRevTelemetry.stepTelemetryByKey.get("rev-a")?.startIso).toBeNull();

    // 2. Revision dispatches its own turn ("turn-rev", running): Authoring must NOT inherit it.
    const duringRevisionThread = makeThread("thread-shared", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-rev"),
        state: "running",
        requestedAt: "2026-04-24T12:01:00.000Z",
        startedAt: "2026-04-24T12:01:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const duringRevTelemetry = computeWorkflowRunTelemetry({
      phases: phasesBeforeRevTurn,
      threadById: new Map([[sharedThreadId, duringRevisionThread]]),
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:01:00.000Z",
    });
    expect(duringRevTelemetry.stepTelemetryByKey.get("author-a")?.elapsedLabel).toBeNull();
    expect(duringRevTelemetry.stepTelemetryByKey.get("rev-a")?.isLive).toBe(true);
    expect(duringRevTelemetry.stepTelemetryByKey.get("rev-a")?.startIso).toBe(
      "2026-04-24T12:01:00.000Z",
    );

    // 3. Revision finishes ("turn-rev": 35s): Revision shows 35s; Authoring does NOT copy 35s.
    const afterRevisionThread = makeThread("thread-shared", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-rev"),
        state: "completed",
        requestedAt: "2026-04-24T12:01:00.000Z",
        startedAt: "2026-04-24T12:01:00.000Z",
        completedAt: "2026-04-24T12:01:35.000Z",
        assistantMessageId: null,
      },
    });
    const phasesAfterRev: WorkflowTimelinePhase[] = [
      phasesBeforeRevTurn[0]!,
      {
        id: "revision",
        label: "Revision",
        state: "completed",
        parallel: true,
        steps: [
          makeStep({
            key: "rev-a",
            label: "Branch A",
            threadId: sharedThreadId,
            turnId: "turn-rev",
            state: "completed",
          }),
        ],
      },
    ];
    const afterRevTelemetry = computeWorkflowRunTelemetry({
      phases: phasesAfterRev,
      threadById: new Map([[sharedThreadId, afterRevisionThread]]),
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:10:00.000Z",
    });
    expect(afterRevTelemetry.stepTelemetryByKey.get("author-a")?.elapsedLabel).toBeNull();
    expect(afterRevTelemetry.stepTelemetryByKey.get("rev-a")?.elapsedLabel).toBe("35s");
    // Settled run elapsed stays anchored to last step completion (12:01:35), not mutable updatedAt (12:10:00).
    expect(afterRevTelemetry.totalElapsedLabel).toBe("1m 35s");
  });

  it("awards bottleneck badges only in parallel phases, never in sequential Reader pass", () => {
    const fastThread = makeThread("thread-fast", {
      estimatedContextTokens: 12_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-fast"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:10.000Z",
        assistantMessageId: null,
      },
    });
    const slowThread = makeThread("thread-slow", {
      estimatedContextTokens: 28_000,
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-slow"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:40.000Z",
        assistantMessageId: null,
      },
    });
    const readerThread = makeThread("thread-reader", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-reader"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:40.000Z",
        startedAt: "2026-04-24T12:00:40.000Z",
        completedAt: "2026-04-24T12:00:50.000Z",
        assistantMessageId: null,
      },
    });
    const polishThread = makeThread("thread-polish", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-polish"),
        state: "completed",
        requestedAt: "2026-04-24T12:00:50.000Z",
        startedAt: "2026-04-24T12:00:50.000Z",
        completedAt: "2026-04-24T12:01:20.000Z",
        assistantMessageId: null,
      },
    });

    const telemetry = computeWorkflowRunTelemetry({
      phases: [
        {
          id: "authoring",
          label: "Drafting",
          state: "completed",
          parallel: true,
          steps: [
            makeStep({
              key: "author-a",
              label: "Branch A",
              threadId: fastThread.id,
              turnId: "turn-fast",
              state: "completed",
            }),
            makeStep({
              key: "author-b",
              label: "Branch B",
              threadId: slowThread.id,
              turnId: "turn-slow",
              state: "completed",
            }),
          ],
        },
        {
          id: "reader-pass",
          label: "Reader pass",
          state: "completed",
          steps: [
            makeStep({
              key: "reader-review",
              label: "Reader review",
              threadId: readerThread.id,
              turnId: "turn-reader",
              state: "completed",
            }),
            makeStep({
              key: "polish",
              label: "Polish",
              threadId: polishThread.id,
              turnId: "turn-polish",
              state: "completed",
            }),
          ],
        },
      ],
      threadById: new Map([
        [fastThread.id, fastThread],
        [slowThread.id, slowThread],
        [readerThread.id, readerThread],
        [polishThread.id, polishThread],
      ]),
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:01:20.000Z",
    });

    expect(telemetry.stepTelemetryByKey.get("author-b")?.isBottleneck).toBe(true);
    expect(telemetry.stepTelemetryByKey.get("author-a")?.isBottleneck).toBe(false);
    // Sequential Reader pass never awards a parallel bottleneck badge.
    expect(telemetry.stepTelemetryByKey.get("reader-review")?.isBottleneck).toBe(false);
    expect(telemetry.stepTelemetryByKey.get("polish")?.isBottleneck).toBe(false);
    expect(telemetry.totalContextTokens).toBe(40_000);
    expect(telemetry.contextThreadCount).toBe(2);
  });

  it("keeps live run telemetry active when one branch errors while a sibling is still running", () => {
    const failedThread = makeThread("thread-failed", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-fail"),
        state: "error",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: "2026-04-24T12:00:08.000Z",
        assistantMessageId: null,
      },
    });
    const runningThread = makeThread("thread-running", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-run"),
        state: "running",
        requestedAt: "2026-04-24T12:00:00.000Z",
        startedAt: "2026-04-24T12:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    const telemetry = computeWorkflowRunTelemetry({
      phases: [
        {
          id: "authoring",
          label: "Authoring",
          state: "error",
          parallel: true,
          steps: [
            makeStep({
              key: "author-a",
              label: "Branch A",
              threadId: failedThread.id,
              turnId: "turn-fail",
              state: "error",
            }),
            makeStep({
              key: "author-b",
              label: "Branch B",
              threadId: runningThread.id,
              turnId: "turn-run",
              state: "active",
            }),
          ],
        },
      ],
      threadById: new Map([
        [failedThread.id, failedThread],
        [runningThread.id, runningThread],
      ]),
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:08.000Z",
    });

    expect(telemetry.errorSteps).toBe(1);
    expect(telemetry.activeSteps).toBe(1);
    expect(telemetry.isRunLive).toBe(true);
    expect(telemetry.stepTelemetryByKey.get("author-b")?.isLive).toBe(true);
    expect(telemetry.stepTelemetryByKey.get("author-a")?.elapsedLabel).toBe("8.0s");
  });
});
