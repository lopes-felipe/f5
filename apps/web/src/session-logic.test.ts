import {
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createLocalDispatchSnapshot,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  hasServerAcknowledgedLocalDispatch,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: {
      provider: "codex",
      status: "ready",
      orchestrationStatus: "ready",
      activeTurnId: undefined,
      createdAt: "2026-02-23T00:00:00.000Z",
      updatedAt: "2026-02-23T00:00:00.000Z",
    },
    messages: [],
    commandExecutions: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    error: null,
    createdAt: "2026-02-23T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-02-23T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      requestedAt: "2026-02-23T00:00:00.000Z",
      startedAt: "2026-02-23T00:00:01.000Z",
      completedAt: "2026-02-23T00:00:02.000Z",
      assistantMessageId: null,
    },
    lastVisitedAt: "2026-02-23T00:00:00.000Z",
    branch: null,
    worktreePath: null,
    detailsLoaded: true,
    sessionNotes: null,
    threadReferences: [],
    ...overrides,
  };
}

function makeLocalDispatchSnapshot() {
  return {
    startedAt: "2026-02-23T00:00:03.000Z",
    preparingWorktree: false,
    latestTurnTurnId: TurnId.makeUnsafe("turn-1"),
    latestTurnRequestedAt: "2026-02-23T00:00:00.000Z",
    latestTurnStartedAt: "2026-02-23T00:00:01.000Z",
    latestTurnCompletedAt: "2026-02-23T00:00:02.000Z",
    sessionOrchestrationStatus: "ready" as const,
    sessionUpdatedAt: "2026-02-23T00:00:00.000Z",
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("maps Codex permission requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-permissions",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Permission approval requested",
        tone: "approval",
        payload: {
          requestId: "req-permissions",
          requestType: "permissions_approval",
          detail: "Network access requested",
          requestedPermissions: {
            network: true,
          },
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-permissions",
        requestKind: "permission",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "Network access requested",
        requestedPermissions: {
          network: true,
        },
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe("local dispatch acknowledgement", () => {
  it("captures the current latest-turn and session snapshot", () => {
    const snapshot = createLocalDispatchSnapshot(makeThread(), {
      preparingWorktree: true,
    });

    expect(snapshot.preparingWorktree).toBe(true);
    expect(snapshot.latestTurnTurnId).toBe(TurnId.makeUnsafe("turn-1"));
    expect(snapshot.latestTurnRequestedAt).toBe("2026-02-23T00:00:00.000Z");
    expect(snapshot.latestTurnStartedAt).toBe("2026-02-23T00:00:01.000Z");
    expect(snapshot.latestTurnCompletedAt).toBe("2026-02-23T00:00:02.000Z");
    expect(snapshot.sessionOrchestrationStatus).toBe("ready");
    expect(snapshot.sessionUpdatedAt).toBe("2026-02-23T00:00:00.000Z");
  });

  it("does not acknowledge an unchanged thread", () => {
    const thread = makeThread();

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges authoritative running and blocking states", () => {
    const thread = makeThread();

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "running",
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasPendingApproval: true,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasPendingApproval: false,
        hasPendingUserInput: true,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: thread.latestTurn,
        session: thread.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: "boom",
      }),
    ).toBe(true);
  });

  it("acknowledges latest-turn and session deltas", () => {
    const thread = makeThread();

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: {
          ...thread.latestTurn!,
          turnId: TurnId.makeUnsafe("turn-2"),
        },
        session: thread.session,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: makeLocalDispatchSnapshot(),
        phase: "ready",
        latestTurn: thread.latestTurn,
        session: {
          ...thread.session!,
          updatedAt: "2026-02-23T00:00:04.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("prefers a newer same-turn task snapshot over the initial plan update", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(
      deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"), {
        tasks: [
          {
            id: "task-1",
            content: "Inspect current behavior",
            activeForm: "Inspecting current behavior",
            status: "completed",
          },
          {
            id: "task-2",
            content: "Run typecheck",
            activeForm: "Running typecheck",
            status: "in_progress",
          },
        ],
        turnId: TurnId.makeUnsafe("turn-1"),
        updatedAt: "2026-02-23T00:00:03.000Z",
      }),
    ).toEqual({
      createdAt: "2026-02-23T00:00:03.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [
        { step: "Inspecting current behavior", status: "completed" },
        { step: "Running typecheck", status: "inProgress" },
      ],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.makeUnsafe("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("keeps only global diagnostics visible when the work log is scoped to the latest turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "global-warning",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "config.warning",
        summary: "Configuration warning",
        tone: "info",
        payload: {
          detail: "Unsupported key",
        },
      }),
      makeActivity({
        id: "old-hook",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "hook.completed",
        summary: "post_tool_use hook (completed)",
      }),
      makeActivity({
        id: "latest-tool",
        createdAt: "2026-02-23T00:00:03.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Ran command",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["global-warning", "latest-tool"]);
  });

  it("keeps completed historical file_change entries visible across later turns", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "historical-file-change",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Updated file",
        payload: {
          itemType: "file_change",
          status: "completed",
          changedFiles: ["inline-diff-demo.txt"],
        },
      }),
      makeActivity({
        id: "latest-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Ran command",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["historical-file-change", "latest-tool"]);
  });

  it("keeps historical file_change entries visible when tool.completed omitted the payload status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "historical-file-change",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Updated file",
        payload: {
          itemType: "file_change",
          changedFiles: ["inline-diff-demo.txt"],
        },
      }),
      makeActivity({
        id: "latest-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Ran command",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["historical-file-change", "latest-tool"]);
    expect(entries[0]?.status).toBe("completed");
  });

  it("keeps historical file_change entries visible when tool.updated carries completed status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "historical-file-change",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Updated file",
        payload: {
          itemType: "file_change",
          status: "completed",
          changedFiles: ["inline-diff-demo.txt"],
        },
      }),
      makeActivity({
        id: "latest-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Ran command",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["historical-file-change", "latest-tool"]);
    expect(entries[0]?.status).toBe("completed");
  });

  it("filters noisy account diagnostics from the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "account-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "account.updated",
        summary: "Account updated",
        tone: "info",
      }),
      makeActivity({
        id: "rate-limits-updated",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "account.rate-limits.updated",
        summary: "Account rate limits updated",
        tone: "info",
      }),
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "summarized",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["runtime-warning"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits runtime configured entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-configured",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.configured",
        summary: "Runtime configured",
        tone: "info",
        payload: {
          model: "claude-haiku-4-5",
        },
      }),
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          detail: "Retrying",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "summarized",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["runtime-warning"]);
  });

  it("hides runtime warnings when visibility is hidden", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Provider got slow",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "hidden",
    });
    expect(entries).toEqual([]);
  });

  it("keeps runtime warnings summarized when visibility is summarized", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Provider got slow",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "summarized",
    });
    expect(entry?.label).toBe("Runtime warning");
  });

  it("shows the runtime warning message when visibility is full", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Provider got slow",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "full",
    });
    expect(entry?.label).toBe("Provider got slow");
  });

  it("hides benign codex stderr warnings even when visibility is full", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-04-10T15:53:06.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message:
            '2026-04-10T15:53:06.704277Z ERROR opentelemetry_sdk:  name="BatchSpanProcessor.Flush.ExportError" reason="InternalFailure(\\"reqwest::Error { kind: Status(400, None), url: \\\\\\"https://otel-mobile.doordash.com/v1/logs\\\\\\" }\\")" Failed during the export process',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "full",
    });
    expect(entries).toEqual([]);
  });

  it("falls back to the summarized label when a full runtime warning lacks a message", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          detail: "Retrying",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "full",
    });
    expect(entry?.label).toBe("Runtime warning");
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          command: "bun run lint",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          command: "bun run dev",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          changedFiles: ["apps/web/src/components/ChatView.tsx", "apps/web/src/session-logic.ts"],
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("falls back to legacy raw payloads when compact changed files are unavailable", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            patch: [
              "*** Begin Patch",
              "*** Update File: apps/web/src/components/chat/MessagesTimeline.tsx",
              "@@",
              "-old line",
              "+new line",
              "*** Add File: apps/web/src/components/chat/NewFile.tsx",
              "+export const value = 1;",
              "*** Move to: apps/web/src/components/chat/RenamedFile.tsx",
              "*** End Patch",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/chat/MessagesTimeline.tsx",
      "apps/web/src/components/chat/NewFile.tsx",
      "apps/web/src/components/chat/RenamedFile.tsx",
    ]);
  });

  it("suppresses command tool lifecycle rows while keeping approvals visible", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
        },
      }),
      makeActivity({
        id: "approval-row",
        kind: "approval.requested",
        tone: "approval",
        summary: "Command approval requested",
        payload: {
          requestKind: "command",
          requestId: "request-1",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      suppressCommandToolLifecycle: true,
    });

    expect(entries.map((entry) => entry.id)).toEqual(["approval-row"]);
  });

  it("keeps transcript rows when compact command lifecycle entries are suppressed", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            command: "bun run lint",
          },
        }),
      ],
      undefined,
      {
        suppressCommandToolLifecycle: true,
      },
    );

    const timeline = deriveTimelineEntries([], [], workEntries, [
      {
        id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        providerItemId: null,
        command: "bun run lint",
        title: "bash",
        status: "completed",
        detail: null,
        exitCode: 0,
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:00:03.000Z",
        updatedAt: "2026-03-20T10:00:03.000Z",
        startedSequence: 1,
        lastUpdatedSequence: 2,
      },
    ]);

    expect(workEntries).toEqual([]);
    expect(timeline.map((entry) => entry.kind)).toEqual(["command"]);
  });

  it("preserves canonical search summaries for command lifecycle worklog rows", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-search",
          kind: "tool.completed",
          summary:
            "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
          payload: {
            itemType: "command_execution",
            title:
              "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
            command:
              "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 300",
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: "command-search",
        label: "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
        toolTitle:
          "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
      }),
    ]);
  });

  it("preserves normalized Claude read/search hints on work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-read",
          kind: "tool.completed",
          summary: "Tool call",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
        makeActivity({
          id: "claude-search",
          kind: "tool.completed",
          summary: "Tool call",
          payload: {
            itemType: "dynamic_tool_call",
            title: "Searching apps/web/src for CommandTranscriptCard",
            searchSummary: "Searching apps/web/src for CommandTranscriptCard",
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: "claude-read",
        providerItemId: "provider-item-read",
        toolTitle: "Read file",
        requestKind: "file-read",
        readPaths: ["apps/server/package.json"],
        lineSummary: "line 12",
      }),
      expect.objectContaining({
        id: "claude-search",
        toolTitle: "Searching apps/web/src for CommandTranscriptCard",
        searchSummary: "Searching apps/web/src for CommandTranscriptCard",
      }),
    ]);
  });

  it("collapses identical tool snapshots for the same provider item", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-read-updated",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Tool updated",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
        makeActivity({
          id: "claude-read-completed",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: "claude-read-completed",
        providerItemId: "provider-item-read",
        lineSummary: "line 12",
      }),
    ]);
  });

  it("keeps tool snapshots when the visible read range changes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-read-line-12",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Tool updated",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
        makeActivity({
          id: "claude-read-lines-12-18",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "lines 12-18",
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "claude-read-line-12",
      "claude-read-lines-12-18",
    ]);
  });

  it("keeps tool snapshots when the visible search summary changes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-search-a",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Tool updated",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-search",
            title: "Searching apps/web/src for CommandTranscriptCard",
            searchSummary: "Searching apps/web/src for CommandTranscriptCard",
          },
        }),
        makeActivity({
          id: "claude-search-b",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-search",
            title: "Searching apps/web/src for MessagesTimeline",
            searchSummary: "Searching apps/web/src for MessagesTimeline",
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual(["claude-search-a", "claude-search-b"]);
  });

  it("keeps tool snapshots when the visible changed file list changes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "file-change-one",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Tool updated",
          payload: {
            itemType: "file_change",
            providerItemId: "provider-item-file-change",
            title: "File change",
            changedFiles: ["NOTICE.md"],
            fileChangeId: "filechange:thread-1:item-1",
          },
        }),
        makeActivity({
          id: "file-change-two",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "file_change",
            providerItemId: "provider-item-file-change",
            title: "File change",
            changedFiles: ["NOTICE.md", "CHANGELOG.md"],
            fileChangeId: "filechange:thread-1:item-1",
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual(["file-change-one", "file-change-two"]);
  });

  it("does not collapse identical rows from different provider items", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-read-provider-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read-1",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
        makeActivity({
          id: "claude-read-provider-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "provider-item-read-2",
            title: "Read file",
            requestKind: "file-read",
            readPaths: ["apps/server/package.json"],
            lineSummary: "line 12",
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "claude-read-provider-1",
      "claude-read-provider-2",
    ]);
  });

  it("derives reasoning-update display hints from payloads and legacy detail text", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "reasoning-read",
          kind: "task.progress",
          summary: "Reasoning update",
          tone: "info",
          payload: {
            detail: "Reading lines 120-180 of apps/web/src/components/ui/alert.tsx",
            readPaths: ["apps/web/src/components/ui/alert.tsx"],
            lineSummary: "lines 120-180",
          },
        }),
        makeActivity({
          id: "reasoning-search",
          kind: "task.progress",
          summary: "Reasoning update",
          tone: "info",
          payload: {
            detail: 'Running grep -r "serverConfigQuery|useServerConfig" apps/web/src',
          },
        }),
      ],
      undefined,
    );

    expect(entries).toEqual([
      expect.objectContaining({
        id: "reasoning-read",
        label: "Reasoning update",
        readPaths: ["apps/web/src/components/ui/alert.tsx"],
        lineSummary: "lines 120-180",
      }),
      expect.objectContaining({
        id: "reasoning-search",
        label: "Reasoning update",
        searchSummary: "Searching apps/web/src for serverConfigQuery, useServerConfig",
      }),
    ]);
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("includes command transcript entries in stable command-start order", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-2"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command: "bun run typecheck",
          title: "bash",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          updatedAt: "2026-03-20T10:00:05.000Z",
          startedSequence: 2,
          lastUpdatedSequence: 3,
        },
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-1"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command: "bun run lint",
          title: "bash",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:03.000Z",
          updatedAt: "2026-03-20T10:00:03.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["command", "command"]);
    expect(entries.map((entry) => entry.id)).toEqual([
      "cmdexec:thread-1:item-1",
      "cmdexec:thread-1:item-2",
    ]);
  });

  it("maps sed file-read command executions to work log style entries", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-read"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command:
            "/bin/zsh -lc 'sed -n \"12p\" apps/web/src/components/chat/MessagesTimeline.tsx'",
          cwd: "/repo/apps/web",
          title: "Ran command",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:01.000Z",
          updatedAt: "2026-03-20T10:00:01.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "work",
      entry: {
        label: "Read file",
        cwd: "/repo/apps/web",
        detail: "line 12",
        changedFiles: ["apps/web/src/components/chat/MessagesTimeline.tsx"],
        requestKind: "file-read",
        tone: "tool",
      },
    });
  });

  it("maps multi-file sed reads to file-read work entries with changed file previews", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-read-multi"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command:
            "/bin/zsh -lc 'sed -n \"12p\" apps/web/src/a.ts apps/web/src/b.ts apps/web/src/c.ts'",
          title: "Ran command",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:01.000Z",
          updatedAt: "2026-03-20T10:00:01.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "work",
      entry: {
        label: "Read file",
        detail: "line 12",
        changedFiles: ["apps/web/src/a.ts", "apps/web/src/b.ts", "apps/web/src/c.ts"],
        requestKind: "file-read",
        tone: "tool",
      },
    });
  });

  it("maps nl plus sed file reads to work log style entries", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-read-numbered"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command: "/bin/zsh -lc \"nl -ba apps/web/src/routes/__root.tsx | sed -n '720,860p'\"",
          title: "Ran command",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:01.000Z",
          updatedAt: "2026-03-20T10:00:01.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "work",
      entry: {
        label: "Read file",
        detail: "lines 720-860",
        changedFiles: ["apps/web/src/routes/__root.tsx"],
        requestKind: "file-read",
        tone: "tool",
      },
    });
  });

  it("maps ripgrep searches with explicit targets to search work entries", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-rg"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command: "rg -n \"CommandTranscriptCard\" apps/web/src/components/chat -g '*test*'",
          title: "Ran command",
          status: "completed",
          detail: null,
          exitCode: 1,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:01.000Z",
          updatedAt: "2026-03-20T10:00:01.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "work",
      entry: {
        label: "Searching apps/web/src/components/chat for CommandTranscriptCard",
        itemType: "command_execution",
        requestKind: "command",
        toolTitle: "Searching apps/web/src/components/chat for CommandTranscriptCard",
        tone: "tool",
      },
    });
  });

  it("maps grep-style search commands to compact work entries", () => {
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        {
          id: OrchestrationCommandExecutionId.makeUnsafe("cmdexec:thread-1:item-search"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          providerItemId: null,
          command:
            "rg -n 'chat\\.newLocal|chat\\.scrollToBottom|workflow\\.new|KeybindingCommand|shortcutCommand' apps packages | head -n 20",
          title: "Ran command",
          status: "completed",
          detail: null,
          exitCode: 0,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:01.000Z",
          updatedAt: "2026-03-20T10:00:01.000Z",
          startedSequence: 1,
          lastUpdatedSequence: 2,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "work",
      entry: {
        label: "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
        itemType: "command_execution",
        requestKind: "command",
        toolTitle:
          "Searching apps, packages for chat.newLocal, chat.scrollToBottom, workflow.new, …",
        tone: "tool",
      },
    });
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises Claude while keeping Cursor as an unavailable placeholder", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
