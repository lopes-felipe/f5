import {
  EventId,
  MessageId,
  OrchestrationCommandExecutionId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createLocalDispatchSnapshot,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveLatestAssistantOutputAt,
  deriveLiveWorkActivity,
  deriveLiveWorkTurnId,
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
  formatElapsed,
} from "./session-logic";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Thread,
} from "./types";
import { formatUsageResumeTime } from "./lib/usageLimits";

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

describe("elapsed time units", () => {
  it("uses milliseconds below one second and seconds for actual multi-second intervals", () => {
    const start = "2026-11-14T12:37:46.000Z";
    expect(formatElapsed(start, start)).toBe("0ms");
    expect(formatElapsed(start, "2026-11-14T12:37:46.044Z")).toBe("44ms");
    expect(formatElapsed(start, "2026-11-14T12:37:46.999Z")).toBe("999ms");
    expect(formatElapsed(start, "2026-11-14T12:37:47.000Z")).toBe("1.0s");
    expect(formatElapsed(start, "2026-11-14T12:37:50.400Z")).toBe("4.4s");
  });
});

describe("deriveLiveWorkActivity", () => {
  const turnId = TurnId.makeUnsafe("turn-live");
  const tool = (kind: string, itemId: string, sequence: number, title = itemId) =>
    makeActivity({
      id: `${kind}-${itemId}-${sequence}`,
      kind,
      summary: kind === "tool.started" ? `${title} started` : title,
      payload: { itemType: "dynamic_tool_call", providerItemId: itemId, title },
      turnId: "turn-live",
      sequence,
    });
  const reasoning = (state: "active" | "idle", sequence: number, detail?: string) =>
    makeActivity({
      id: "reasoning-status:thread-1:turn-live",
      kind: "reasoning.status",
      summary: "Thinking",
      tone: "info",
      payload: { state, ...(detail ? { detail } : {}) },
      turnId: "turn-live",
      sequence,
    });

  it("shows thinking while the reasoning status is active", () => {
    expect(deriveLiveWorkActivity([reasoning("active", 1)], turnId)).toEqual({
      kind: "thinking",
      detail: null,
    });
    expect(deriveLiveWorkActivity([reasoning("active", 1, "Inspecting")], turnId)).toEqual({
      kind: "thinking",
      detail: "Inspecting",
    });
    expect(deriveLiveWorkActivity([reasoning("idle", 1)], turnId)).toEqual({ kind: "idle" });
  });

  it("keeps the latest thought on a tool that runs after it", () => {
    expect(
      deriveLiveWorkActivity(
        [reasoning("idle", 1, "Found the cause"), tool("tool.started", "A", 2, "rg cause")],
        turnId,
      ),
    ).toEqual({ kind: "tool", providerItemId: "A", title: "rg cause", thought: "Found the cause" });
    expect(deriveLiveWorkActivity([tool("tool.started", "A", 1)], turnId)).toEqual({
      kind: "tool",
      providerItemId: "A",
      title: "A",
    });
  });

  it("keeps the newer tool when an older one completes", () => {
    expect(
      deriveLiveWorkActivity(
        [
          tool("tool.started", "A", 1),
          tool("tool.started", "B", 2),
          tool("tool.completed", "A", 3),
        ],
        turnId,
      ),
    ).toEqual({ kind: "tool", providerItemId: "B", title: "B" });
  });

  it("keeps thinking when a background tool completes during reasoning", () => {
    expect(
      deriveLiveWorkActivity(
        [tool("tool.started", "A", 1), reasoning("active", 2), tool("tool.completed", "A", 3)],
        turnId,
      ),
    ).toEqual({ kind: "thinking", detail: null });
  });

  it("shows a tool that has only started", () => {
    expect(
      deriveLiveWorkActivity(
        [
          makeActivity({
            id: "started-only",
            kind: "tool.started",
            summary: "Ran command started",
            payload: { itemType: "command_execution", providerItemId: "cmd" },
            turnId: "turn-live",
            sequence: 1,
          }),
        ],
        turnId,
      ),
    ).toEqual({ kind: "tool", providerItemId: "cmd", title: "Ran command" });
  });

  it("labels a running command with its command text", () => {
    expect(
      deriveLiveWorkActivity(
        [
          makeActivity({
            id: "command-started",
            kind: "tool.started",
            summary: "Ran command started",
            payload: {
              itemType: "command_execution",
              providerItemId: "cmd",
              title: "Ran command",
              command: "bun run test",
            },
            turnId: "turn-live",
            sequence: 1,
          }),
        ],
        turnId,
      ),
    ).toEqual({ kind: "tool", providerItemId: "cmd", title: "bun run test" });
  });

  it("keeps a completed tool closed when its start sorts after the completion", () => {
    // No session sequence and equal timestamps: ids decide the order.
    const createdAt = "2026-02-23T00:00:05.000Z";
    const payload = { itemType: "command_execution", providerItemId: "cmd", title: "Ran command" };
    expect(
      deriveLiveWorkActivity(
        [
          makeActivity({
            id: "b-started",
            kind: "tool.started",
            payload,
            createdAt,
            turnId: "turn-live",
          }),
          makeActivity({
            id: "a-completed",
            kind: "tool.completed",
            payload: { ...payload, status: "completed" },
            createdAt,
            turnId: "turn-live",
          }),
        ],
        turnId,
      ),
    ).toEqual({ kind: "idle" });
  });

  it("closes tools without an item id when an id-less completion follows", () => {
    const idless = (id: string, kind: string, sequence: number) =>
      makeActivity({
        id,
        kind,
        summary: "Tool call",
        payload: { itemType: "dynamic_tool_call", title: "Lookup" },
        turnId: "turn-live",
        sequence,
      });
    expect(deriveLiveWorkActivity([idless("s", "tool.started", 1)], turnId)).toEqual({
      kind: "tool",
      providerItemId: null,
      title: "Lookup",
    });
    expect(
      deriveLiveWorkActivity(
        [idless("s", "tool.started", 1), idless("c", "tool.completed", 2)],
        turnId,
      ),
    ).toEqual({ kind: "idle" });
  });

  it("ignores activities from other turns", () => {
    expect(
      deriveLiveWorkActivity(
        [makeActivity({ kind: "tool.started", turnId: "turn-old", sequence: 1 })],
        turnId,
      ),
    ).toEqual({ kind: "idle" });
    expect(deriveLiveWorkActivity([tool("tool.started", "A", 1)], undefined)).toBeNull();
  });

  it("reads as generic work while waiting on the user, but keeps an open item", () => {
    expect(deriveLiveWorkActivity([], turnId, { awaitingUser: true })).toBeNull();
    expect(
      deriveLiveWorkActivity([tool("tool.started", "A", 1)], turnId, { awaitingUser: true }),
    ).toEqual({ kind: "tool", providerItemId: "A", title: "A" });
  });

  it("reads as generic work while a hook runs", () => {
    const hook = (kind: string, sequence: number) =>
      makeActivity({
        id: `${kind}-${sequence}`,
        kind,
        tone: "info",
        payload: { hookId: "hook-1", hookEvent: "PreToolUse" },
        turnId: "turn-live",
        sequence,
      });
    expect(deriveLiveWorkActivity([hook("hook.started", 1)], turnId)).toBeNull();
    expect(
      deriveLiveWorkActivity([hook("hook.started", 1), hook("hook.completed", 2)], turnId),
    ).toEqual({ kind: "idle" });
  });

  it("finds the latest assistant output of the turn", () => {
    const message = (
      role: "user" | "assistant",
      createdAt: string,
      completedAt?: string,
      messageTurnId: TurnId | null = turnId,
    ) => ({ role, turnId: messageTurnId, createdAt, completedAt });
    expect(
      deriveLatestAssistantOutputAt(
        [
          message("assistant", "2026-02-23T00:00:01.000Z", "2026-02-23T00:00:04.000Z"),
          message("assistant", "2026-02-23T00:00:03.000Z"),
          message("user", "2026-02-23T00:00:09.000Z"),
          message("assistant", "2026-02-23T00:00:08.000Z", undefined, TurnId.makeUnsafe("old")),
        ],
        turnId,
      ),
    ).toBe("2026-02-23T00:00:04.000Z");
    expect(deriveLatestAssistantOutputAt([], turnId)).toBeNull();
    expect(
      deriveLatestAssistantOutputAt([message("assistant", "2026-02-23T00:00:01.000Z")], undefined),
    ).toBeNull();
  });

  describe("stream retries", () => {
    const at = (second: number) => `2026-02-23T00:00:${String(second).padStart(2, "0")}.000Z`;
    const retry = (second: number, message = "Reconnecting... 2/5") =>
      makeActivity({
        id: `retry-${second}`,
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: { message, detail: { willRetry: true } },
        turnId: "turn-live",
        createdAt: at(second),
      });
    const status = (createdSecond: number, updatedSecond: number) =>
      makeActivity({
        id: "reasoning-status:thread-1:turn-live",
        kind: "reasoning.status",
        summary: "Thinking",
        tone: "info",
        payload: { state: "idle", updatedAt: at(updatedSecond) },
        turnId: "turn-live",
        createdAt: at(createdSecond),
      });
    const completedTool = (second: number) =>
      makeActivity({
        id: `tool-${second}`,
        kind: "tool.completed",
        payload: { itemType: "command_execution", providerItemId: `cmd-${second}` },
        turnId: "turn-live",
        createdAt: at(second),
      });

    it("reads as reconnecting until something follows the latest retry", () => {
      expect(deriveLiveWorkActivity([completedTool(1), retry(2)], turnId)).toEqual({
        kind: "reconnecting",
        attempt: "2/5",
      });
      expect(
        deriveLiveWorkActivity(
          [retry(1), retry(3, "Reconnecting... 3 / 5"), completedTool(2)],
          turnId,
        ),
      ).toEqual({ kind: "reconnecting", attempt: "3/5" });
      expect(deriveLiveWorkActivity([retry(1, "Stream dropped")], turnId)).toEqual({
        kind: "reconnecting",
        attempt: null,
      });
      expect(deriveLiveWorkActivity([retry(1), completedTool(2)], turnId)).toEqual({
        kind: "idle",
      });
    });

    it("clears on a later reasoning update even though the status was created earlier", () => {
      expect(deriveLiveWorkActivity([status(1, 2), retry(3)], turnId)).toEqual({
        kind: "reconnecting",
        attempt: "2/5",
      });
      expect(deriveLiveWorkActivity([status(1, 4), retry(3)], turnId)).toEqual({ kind: "idle" });
    });

    it("clears on assistant output that follows the retry", () => {
      expect(
        deriveLiveWorkActivity([retry(2)], turnId, { latestAssistantOutputAt: at(3) }),
      ).toEqual({ kind: "idle" });
      expect(
        deriveLiveWorkActivity([retry(2)], turnId, { latestAssistantOutputAt: at(1) }),
      ).toEqual({ kind: "reconnecting", attempt: "2/5" });
    });

    it("does not count status or metadata activities as recovery", () => {
      const metadata = (kind: string) =>
        makeActivity({ kind, tone: "info", turnId: "turn-live", createdAt: at(3) });
      for (const kind of ["task.progress", "turn.plan.updated", "runtime.warning"]) {
        expect(deriveLiveWorkActivity([retry(2), metadata(kind)], turnId)).toEqual({
          kind: "reconnecting",
          attempt: "2/5",
        });
      }
    });

    it("breaks timestamp ties by activity order", () => {
      const tied = (id: string, kind: string, sequence: number) =>
        makeActivity({
          id,
          kind,
          tone: "info",
          payload:
            kind === "runtime.warning"
              ? { message: "Reconnecting... 2/5", detail: { willRetry: true } }
              : { itemType: "command_execution", providerItemId: "cmd" },
          turnId: "turn-live",
          createdAt: at(2),
          sequence,
        });
      expect(
        deriveLiveWorkActivity(
          [tied("retry", "runtime.warning", 1), tied("done", "tool.completed", 2)],
          turnId,
        ),
      ).toEqual({ kind: "idle" });
      expect(
        deriveLiveWorkActivity(
          [tied("done", "tool.completed", 1), tied("retry", "runtime.warning", 2)],
          turnId,
        ),
      ).toEqual({ kind: "reconnecting", attempt: "2/5" });
    });

    it("leaves an open item in charge and ignores warnings that will not retry", () => {
      expect(deriveLiveWorkActivity([tool("tool.started", "A", 1), retry(2)], turnId)).toEqual({
        kind: "tool",
        providerItemId: "A",
        title: "A",
      });
      expect(
        deriveLiveWorkActivity(
          [
            makeActivity({
              kind: "runtime.warning",
              tone: "info",
              payload: { message: "Heads up", detail: { willRetry: false } },
              turnId: "turn-live",
            }),
          ],
          turnId,
        ),
      ).toEqual({ kind: "idle" });
    });
  });

  it("only exposes a live turn for a running session on the latest turn", () => {
    expect(deriveLiveWorkTurnId({ status: "running", activeTurnId: turnId }, turnId)).toBe(turnId);
    for (const status of ["ready", "error", "closed", "connecting"] as const) {
      expect(deriveLiveWorkTurnId({ status, activeTurnId: turnId }, turnId)).toBeUndefined();
    }
    // Sending before the new turn exists: the session still points at the old turn.
    expect(
      deriveLiveWorkTurnId(
        { status: "running", activeTurnId: TurnId.makeUnsafe("turn-old") },
        turnId,
      ),
    ).toBeUndefined();
    expect(deriveLiveWorkTurnId({ status: "running" }, turnId)).toBeUndefined();
    expect(deriveLiveWorkTurnId(null, turnId)).toBeUndefined();
  });

  it("keeps the reasoning status out of the work log", () => {
    expect(deriveWorkLogEntries([reasoning("active", 1)], turnId)).toEqual([]);
  });
});

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
    estimatedThinkingTokens: null,
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

  it.each(["file_read_approval", "file_change_approval"])(
    "preserves the permission profile for %s",
    (requestType) => {
      const requestedPermissions = {
        fileSystem: {
          entries: [
            {
              access: requestType === "file_read_approval" ? "read" : "write",
              path: { type: "glob_pattern", pattern: "/w/**" },
            },
          ],
        },
      };
      const approvals = derivePendingApprovals([
        makeActivity({
          id: "permission-profile",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "approval.requested",
          summary: "File approval",
          tone: "approval",
          payload: { requestId: "permission-profile", requestType, requestedPermissions },
        }),
      ]);
      expect(approvals[0]?.requestKind).toBe(
        requestType === "file_read_approval" ? "file-read" : "file-change",
      );
      expect(approvals[0]?.requestedPermissions).toEqual(requestedPermissions);
    },
  );

  it("keeps unknown approval types actionable", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-unknown",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Unknown approval requested (workspace_policy_approval)",
        tone: "approval",
        payload: {
          requestId: "req-unknown",
          requestType: "workspace_policy_approval",
          detail: "Review this provider request",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-unknown",
        requestKind: "unknown",
        requestType: "workspace_policy_approval",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "Review this provider request",
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
  it("preserves provider option IDs and the custom-answer restriction from persisted activities", () => {
    const question = {
      id: "branch",
      header: "Branch",
      question: "Choose",
      allowCustomAnswer: false,
      options: [{ label: "main", description: "main", value: "opt-main" }],
    };
    expect(
      derivePendingUserInputs([
        makeActivity({
          kind: "user-input.requested",
          payload: { requestId: "branch-request", questions: [question] },
        }),
      ])[0]?.questions,
    ).toEqual([question]);
  });
  it("preserves bounded editor prefills from persisted activities", () => {
    const question = {
      id: "editor",
      header: "Edit",
      question: "Edit draft",
      options: [],
      initialAnswer: "Existing\ntext",
      optional: true,
    };
    const input = derivePendingUserInputs([
      makeActivity({
        kind: "user-input.requested",
        payload: { requestId: "editor-request", questions: [question] },
      }),
    ]);
    expect(input[0]?.questions).toEqual([question]);
  });

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
  it("retains aside answers across later turns without treating them as messages", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.makeUnsafe("aside"),
      kind: "native.aside",
      summary: "Aside",
      tone: "info",
      turnId: null,
      createdAt: "2026-11-03T00:00:00Z",
      payload: { nativeAside: { question: "Why?", text: "Because." } },
    };
    expect(deriveWorkLogEntries([activity], TurnId.makeUnsafe("later"))).toMatchObject([
      { activityKind: "native.aside", label: "Aside: Why?", detail: "Because." },
    ]);
  });
  it("leads an answered user-input row with the question and shows the answer", () => {
    const question = (id: string, text: string) => ({
      id,
      header: id,
      question: text,
      options: [{ label: "Yes", description: "Proceed" }],
    });
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "input-requested",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: "turn-1",
          kind: "user-input.requested",
          summary: "User input requested",
          tone: "info",
          payload: {
            requestId: "req-1",
            questions: [
              question("scope", "Which  package\nshould move?"),
              question("tests", "Keep tests?"),
            ],
          },
        }),
        makeActivity({
          id: "input-resolved",
          createdAt: "2026-02-23T00:00:02.000Z",
          turnId: "turn-1",
          kind: "user-input.resolved",
          summary: "User input submitted",
          tone: "info",
          payload: { requestId: "req-1", answers: { scope: "apps/web", tests: ["Yes"] } },
        }),
        makeActivity({
          id: "receipt",
          createdAt: "2026-02-23T00:00:03.000Z",
          turnId: "turn-1",
          kind: "user-input.resolved",
          summary: "Provider received the requested input",
          tone: "info",
          payload: { requestId: "req-1", receipt: "resolved" },
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );
    const resolved = entries.find((entry) => entry.id === "input-resolved");
    expect(resolved?.label).toBe("Which package should move? · Keep tests?");
    expect(resolved?.detail).toBe("apps/web · Yes");
    // A value-free receipt keeps its own summary.
    expect(entries.find((entry) => entry.id === "receipt")?.label).toBe(
      "Provider received the requested input",
    );
    expect(entries.find((entry) => entry.id === "receipt")?.userInput).toBeUndefined();
  });

  describe("Q&A cards", () => {
    const turn = TurnId.makeUnsafe("turn-2");
    const questions = [
      {
        id: "motion",
        header: "Motion",
        question: "How should focus motion feel?",
        options: [
          { label: "Spring", description: "" },
          { label: "Linear", description: "" },
        ],
      },
      {
        id: "states",
        header: "Question 2",
        question: "Which states get a ring?",
        options: [
          { label: "Installed", description: "" },
          { label: "Pinned", description: "" },
        ],
        multiSelect: true,
      },
    ];
    const requested = (turnId = "turn-2") =>
      makeActivity({
        id: "q-requested",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId,
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: { requestId: "req-q", questions },
      });
    const resolved = (answers: Record<string, unknown>) =>
      makeActivity({
        id: "q-resolved",
        createdAt: "2026-02-23T00:00:05.000Z",
        turnId: "turn-2",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: { requestId: "req-q", answers },
      });

    it("pairs each question with its answers and flags typed ones", () => {
      const entries = deriveWorkLogEntries(
        [
          requested(),
          resolved({
            motion: "Spring",
            states: { answers: ["Installed", "Pinned", "Only when  idle"] },
          }),
        ],
        turn,
      );
      expect(entries.map((entry) => entry.id)).toEqual(["q-resolved"]);
      expect(entries[0]?.userInput).toEqual({
        state: "answered",
        questions: [
          {
            id: "motion",
            header: "Motion",
            question: "How should focus motion feel?",
            answers: [{ text: "Spring", custom: false }],
          },
          {
            id: "states",
            header: "Question 2",
            question: "Which states get a ring?",
            answers: [
              { text: "Installed", custom: false },
              { text: "Pinned", custom: false },
              { text: "Only when idle", custom: true },
            ],
          },
        ],
      });
    });

    it("accepts string-array answers and marks cancelled requests unanswered", () => {
      const answered = deriveWorkLogEntries(
        [requested(), resolved({ states: ["Pinned"] })],
        turn,
      )[0]?.userInput;
      expect(answered?.state).toBe("answered");
      expect(answered?.questions[1]?.answers).toEqual([{ text: "Pinned", custom: false }]);
      expect(answered?.questions[0]?.answers).toEqual([]);

      const cancelled = deriveWorkLogEntries([requested(), resolved({})], turn)[0];
      expect(cancelled?.userInput?.state).toBe("unanswered");
    });

    it("folds a message-mode question and its F5-recorded answer into one card", () => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "async-requested",
            createdAt: "2026-02-23T00:00:01.000Z",
            turnId: "turn-1",
            kind: "user-input.requested",
            summary: "User input requested",
            tone: "info",
            payload: { requestId: "codex-async:q", responseMode: "message", questions },
          }),
          makeActivity({
            id: "user-input-resolved:answer-cmd",
            createdAt: "2026-02-23T00:00:05.000Z",
            turnId: "turn-1",
            kind: "user-input.resolved",
            summary: "User input submitted",
            tone: "info",
            payload: {
              requestId: "codex-async:q",
              resolution: "answered",
              answers: { motion: { answers: ["Spring"] } },
              answerMessageId: "answer:answer-cmd",
            },
          }),
        ],
        turn,
      );
      expect(entries.map((entry) => entry.id)).toEqual(["user-input-resolved:answer-cmd"]);
      expect(entries[0]?.userInput?.state).toBe("answered");
      expect(entries[0]?.userInput?.answerMessageId).toBe("answer:answer-cmd");
      expect(entries[0]?.userInput?.questions[0]?.answers).toEqual([
        { text: "Spring", custom: false },
      ]);
    });

    it("does not link a dismissed message-mode question to a message", () => {
      const entries = deriveWorkLogEntries(
        [
          requested(),
          makeActivity({
            id: "q-dismissed",
            createdAt: "2026-02-23T00:00:05.000Z",
            turnId: "turn-2",
            kind: "user-input.resolved",
            summary: "User input dismissed",
            tone: "info",
            payload: { requestId: "req-q", resolution: "dismissed", answers: {} },
          }),
        ],
        turn,
      );
      expect(entries[0]?.userInput?.state).toBe("unanswered");
      expect(entries[0]?.userInput?.answerMessageId).toBeUndefined();
    });

    it("shows an open request as pending in the latest turn only", () => {
      const pending = deriveWorkLogEntries([requested()], turn);
      expect(pending.map((entry) => entry.userInput?.state)).toEqual(["pending"]);
      const abandoned = deriveWorkLogEntries([requested("turn-1")], undefined);
      expect(abandoned.map((entry) => entry.userInput?.state)).toEqual(["unanswered"]);
    });

    it("keeps prior-turn cards once a newer turn starts", () => {
      const answered = deriveWorkLogEntries(
        [requested(), resolved({ motion: "Linear" })],
        TurnId.makeUnsafe("turn-3"),
      );
      expect(answered.map((entry) => [entry.id, entry.userInput?.state])).toEqual([
        ["q-resolved", "answered"],
      ]);

      // The server closes a request still open at turn end as "dismissed", without answers.
      const dismissed = deriveWorkLogEntries(
        [
          requested(),
          makeActivity({
            id: "q-dismissed",
            createdAt: "2026-02-23T00:00:09.000Z",
            turnId: "turn-2",
            kind: "user-input.resolved",
            summary: "User input dismissed because its turn ended",
            tone: "info",
            payload: { requestId: "req-q", resolution: "dismissed" },
          }),
        ],
        TurnId.makeUnsafe("turn-3"),
      );
      expect(dismissed.map((entry) => [entry.id, entry.userInput?.state])).toEqual([
        ["q-dismissed", "unanswered"],
      ]);

      const abandoned = deriveWorkLogEntries([requested()], TurnId.makeUnsafe("turn-3"));
      expect(abandoned.map((entry) => entry.userInput?.state)).toEqual(["unanswered"]);
    });

    it("follows the composer's pending requests when they are given", () => {
      const open = deriveWorkLogEntries([requested()], turn, {
        pendingUserInputRequestIds: new Set(["req-q"]),
      });
      expect(open[0]?.userInput?.state).toBe("pending");
      // The session stopped: the composer dropped the request without a resolved activity.
      const stopped = deriveWorkLogEntries([requested()], turn, {
        pendingUserInputRequestIds: new Set(),
      });
      expect(stopped[0]?.userInput?.state).toBe("unanswered");
    });

    it("reads value-free receipts as answered or not, keeping indeterminate rows", () => {
      const receipt = (value: string) =>
        makeActivity({
          id: `q-receipt-${value}`,
          createdAt: "2026-02-23T00:00:05.000Z",
          turnId: "turn-2",
          kind: "user-input.resolved",
          summary: "Provider received the requested input",
          tone: value === "indeterminate" ? "error" : "info",
          payload: { requestId: "req-q", receipt: value },
        });
      const stateFor = (value: string) =>
        deriveWorkLogEntries([requested(), receipt(value)], turn).map((entry) => [
          entry.id,
          entry.userInput?.state,
        ]);
      expect(stateFor("resolved")).toEqual([["q-receipt-resolved", "answered"]]);
      expect(stateFor("cancelled")).toEqual([["q-receipt-cancelled", "unanswered"]]);
      // The request stays open, so its card stays beside the indeterminate row.
      expect(stateFor("indeterminate")).toEqual([
        ["q-requested", "pending"],
        ["q-receipt-indeterminate", undefined],
      ]);
    });

    it("keeps a failed AskUserQuestion row and one with no matching request", () => {
      const askTool = (id: string, turnId: string, status: string) =>
        makeActivity({
          id,
          createdAt: turnId === "turn-4" ? "2026-02-23T00:01:00.000Z" : "2026-02-23T00:00:00.500Z",
          turnId,
          kind: "tool.completed",
          tone: status === "failed" ? "error" : "tool",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: id,
            status,
            title: "Tool call",
            detail: 'AskUserQuestion: {"questions":[{"question":"Too many?"}]}',
          },
        });
      const entries = deriveWorkLogEntries(
        [
          askTool("ask-failed", "turn-2", "failed"),
          askTool("ask-asked", "turn-2", "completed"),
          requested(),
          askTool("ask-rejected", "turn-4", "completed"),
        ],
        TurnId.makeUnsafe("turn-4"),
      );
      // turn-2's completed call is shown by its card; the failure and the
      // request-less turn-4 call keep their rows.
      expect(entries.map((entry) => entry.id)).toEqual(["q-requested", "ask-rejected"]);
      const currentTurn = deriveWorkLogEntries(
        [
          askTool("ask-failed", "turn-2", "failed"),
          askTool("ask-asked", "turn-2", "completed"),
          requested(),
        ],
        turn,
      );
      expect(currentTurn.map((entry) => entry.id)).toEqual(["ask-failed", "q-requested"]);
    });

    it("drops the AskUserQuestion tool row but keeps other generic tool calls", () => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "ask-tool",
            createdAt: "2026-02-23T00:00:00.500Z",
            turnId: "turn-2",
            kind: "tool.updated",
            payload: {
              itemType: "dynamic_tool_call",
              providerItemId: "tool-ask",
              title: "Tool call",
              detail: 'AskUserQuestion: {"questions":[{"question":"How should',
            },
          }),
          makeActivity({
            id: "search-tool",
            createdAt: "2026-02-23T00:00:00.700Z",
            turnId: "turn-2",
            kind: "tool.completed",
            payload: {
              itemType: "dynamic_tool_call",
              providerItemId: "tool-search",
              title: "Tool call",
              detail: 'ToolSearch: {"query":"select:Read"}',
            },
          }),
          requested(),
        ],
        turn,
      );
      expect(entries.map((entry) => entry.id)).toEqual(["search-tool", "q-requested"]);
    });
  });

  it("dates a tool row from its filtered-out start activity", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "mcp-started",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: "turn-1",
          kind: "tool.started",
          payload: { itemType: "mcp_tool_call", providerItemId: "mcp-1", status: "inProgress" },
        }),
        makeActivity({
          id: "mcp-completed",
          createdAt: "2026-02-23T00:00:02.500Z",
          turnId: "turn-1",
          kind: "tool.completed",
          payload: { itemType: "mcp_tool_call", providerItemId: "mcp-1", status: "completed" },
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );
    expect(entries.map((entry) => [entry.id, entry.startedAt])).toEqual([
      ["mcp-completed", "2026-02-23T00:00:01.000Z"],
    ]);
  });

  it("coalesces a Codex collaboration lifecycle into one stable retained row", () => {
    const lifecycle = [
      makeActivity({
        id: "collab-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.started",
        summary: "Wait started",
        payload: {
          itemType: "collab_agent_tool_call",
          providerItemId: "collab-item",
          status: "inProgress",
          subagentPrompt: "Check the implementation",
          subagentSenderThreadId: "parent",
          subagentReceiverThreadIds: ["agent-a"],
          codexCollaborationTool: "wait",
        },
      }),
      makeActivity({
        id: "collab-updated",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Wait updated",
        payload: {
          itemType: "collab_agent_tool_call",
          providerItemId: "collab-item",
          status: "inProgress",
          codexCollaborationTool: "wait",
          subagentSenderThreadId: "parent",
          subagentReceiverThreadIds: ["agent-a"],
        },
      }),
      makeActivity({
        id: "collab-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Wait completed",
        payload: {
          itemType: "collab_agent_tool_call",
          providerItemId: "collab-item",
          status: "completed",
          codexCollaborationTool: "wait",
          subagentSenderThreadId: "parent",
          subagentReceiverThreadIds: ["agent-a"],
          subagentStates: [{ threadId: "agent-a", status: "completed", message: "Reviewed" }],
        },
      }),
    ];
    const [entry] = deriveWorkLogEntries(lifecycle, undefined);
    expect(entry).toMatchObject({
      id: "collab-started",
      createdAt: "2026-02-23T00:00:01.000Z",
      status: "completed",
      subagentPrompt: "Check the implementation",
      subagentStates: [{ threadId: "agent-a", status: "completed", message: "Reviewed" }],
    });
    expect(deriveWorkLogEntries(lifecycle, TurnId.makeUnsafe("turn-2"))).toHaveLength(1);

    const regressed = deriveWorkLogEntries(
      [{ ...lifecycle[1]!, createdAt: "2026-02-23T00:00:04.000Z" }, lifecycle[2]!],
      undefined,
    );
    expect(regressed[0]?.status).toBe("completed");
  });

  it("folds a computer call's start, update and completion into one action", () => {
    const call = (kind: string, second: number, payload: Record<string, unknown>) =>
      makeActivity({
        id: `computer-${kind}`,
        createdAt: `2026-02-23T00:00:0${second}.000Z`,
        turnId: "turn-1",
        kind,
        summary: "Computer",
        payload: {
          itemType: "mcp_tool_call",
          providerItemId: "computer-item",
          mcpServerName: "f5_computer",
          mcpToolName: "computer_key",
          computerTool: true,
          ...payload,
        },
      });
    const started = call("tool.started", 1, { status: "inProgress" });
    // A start alone is the live call Codex reports before its completion.
    expect(deriveWorkLogEntries([started], undefined)).toMatchObject([
      { id: "computer-tool.started", status: "inProgress" },
    ]);
    const entries = deriveWorkLogEntries(
      [
        started,
        call("tool.updated", 2, { status: "inProgress", detail: "pressing" }),
        call("tool.completed", 3, {
          status: "completed",
          computerStep: { appName: "Google Chrome", keyChord: "Meta+L" },
        }),
      ],
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "computer-tool.started",
      createdAt: "2026-02-23T00:00:01.000Z",
      status: "completed",
      computerStep: { appName: "Google Chrome", keyChord: "Meta+L" },
    });
    // Starts of other tools stay hidden.
    expect(
      deriveWorkLogEntries(
        [
          makeActivity({
            kind: "tool.started",
            payload: { itemType: "mcp_tool_call", providerItemId: "docs", mcpToolName: "read" },
          }),
        ],
        undefined,
      ),
    ).toHaveLength(0);
  });

  it.each(["computer", "preview"] as const)(
    "retains and coalesces historical %s calls across later turns and reloads",
    (surface) => {
      const payload =
        surface === "computer"
          ? { computerTool: true, mcpToolName: "computer_click" }
          : { mcpServerName: "__f5_preview", mcpToolName: "preview_click" };
      const call = (
        id: string,
        kind: string,
        second: number,
        extra: Record<string, unknown> = {},
      ) =>
        makeActivity({
          id,
          kind,
          createdAt: new Date(Date.UTC(2026, 1, 23, 0, 0, second)).toISOString(),
          turnId: "turn-1",
          payload: {
            itemType: "mcp_tool_call",
            providerItemId: "completed-call",
            ...payload,
            ...extra,
          },
        });
      const image = { attachmentId: "saved-screenshot", mimeType: "image/png", sizeBytes: 10 };
      const activities = [
        call("started", "tool.started", 1, { status: "inProgress" }),
        call("updated", "tool.updated", 2, {
          status: "inProgress",
          mcpImages: [image],
        }),
        // Some providers omit status on tool.completed.
        call("completed", "tool.completed", 3),
        call("failed", "tool.completed", 4, { providerItemId: "failed-call", status: "failed" }),
        call("incomplete", "tool.started", 5, {
          providerItemId: "incomplete-call",
          status: "inProgress",
        }),
        call("without-item-id", "tool.completed", 6, { providerItemId: undefined }),
      ];
      for (const latestTurn of ["turn-1", "turn-2", "turn-4"]) {
        // Fresh objects model activity restored from persistence after a provider switch.
        const restored: OrchestrationThreadActivity[] = JSON.parse(JSON.stringify(activities));
        const entries = deriveWorkLogEntries(restored, TurnId.makeUnsafe(latestTurn));
        expect(entries).toHaveLength(4);
        expect(entries[0]).toMatchObject({
          id: "started",
          createdAt: activities[0]!.createdAt,
          turnId: "turn-1",
          status: "completed",
          mcpImages: [image],
        });
        expect(entries[1]).toMatchObject({ id: "failed", status: "failed" });
        expect(entries[2]).toMatchObject({ id: "incomplete", status: "inProgress" });
        expect(entries[3]).toMatchObject({ id: "without-item-id", status: "completed" });
      }
    },
  );

  it("keeps finished historical MCP calls as plain cards, not automation runs", () => {
    const activities = [
      { mcpToolName: "computer_click" },
      { computerTool: true, mcpToolName: "computer_unknown" },
      { mcpServerName: "custom_preview", mcpToolName: "preview_click" },
      { mcpServerName: "docs", mcpToolName: "read" },
    ].map((payload, index) =>
      makeActivity({
        id: "unrelated-" + index,
        kind: "tool.completed",
        turnId: "turn-1",
        payload: { itemType: "mcp_tool_call", status: "completed", ...payload },
      }),
    );
    const historical = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(historical.map((entry) => entry.id)).toEqual([
      "unrelated-0",
      "unrelated-1",
      "unrelated-2",
      "unrelated-3",
    ]);
    expect(historical.map((entry) => entry.automationRunId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("drops a historical MCP call that never finished and other historical tools", () => {
    const activities = [
      makeActivity({
        id: "mcp-running",
        kind: "tool.updated",
        turnId: "turn-1",
        payload: { itemType: "mcp_tool_call", providerItemId: "mcp-1", status: "inProgress" },
      }),
      makeActivity({
        id: "dynamic-done",
        kind: "tool.completed",
        turnId: "turn-1",
        payload: { itemType: "dynamic_tool_call", status: "completed", detail: "Skill: x" },
      }),
    ];
    expect(deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"))).toEqual([]);
  });

  it("folds an MCP call's completion into its first snapshot", () => {
    const activities = [
      makeActivity({
        id: "mcp-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        payload: {
          itemType: "mcp_tool_call",
          providerItemId: "mcp-1",
          status: "inProgress",
          mcpServerName: "f5_thread",
          mcpToolName: "thread_read",
          mcpInput: '{"limit":3}',
        },
      }),
      makeActivity({
        id: "mcp-completed",
        createdAt: "2026-02-23T00:00:01.551Z",
        turnId: "turn-1",
        kind: "tool.completed",
        // Some providers leave the input off the completion.
        payload: {
          itemType: "mcp_tool_call",
          providerItemId: "mcp-1",
          status: "completed",
          mcpServerName: "f5_thread",
          mcpToolName: "thread_read",
          mcpResult: '{"reason":"self"}',
        },
      }),
    ];
    const running = deriveWorkLogEntries(activities.slice(0, 1), TurnId.makeUnsafe("turn-1"));
    const summarize = (entries: ReturnType<typeof deriveWorkLogEntries>) =>
      entries.map((entry) => [
        entry.id,
        entry.createdAt,
        entry.status,
        entry.completedAt,
        entry.mcpInput,
        entry.mcpResult,
      ]);
    expect(summarize(running)).toEqual([
      [
        "mcp-updated",
        "2026-02-23T00:00:01.000Z",
        "inProgress",
        undefined,
        '{"limit":3}',
        undefined,
      ],
    ]);
    const finished = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-1"));
    const expected = [
      [
        "mcp-updated",
        "2026-02-23T00:00:01.000Z",
        "completed",
        "2026-02-23T00:00:01.551Z",
        '{"limit":3}',
        '{"reason":"self"}',
      ],
    ];
    expect(summarize(finished)).toEqual(expected);
    // The row keeps its id and position once a later turn starts.
    expect(summarize(deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2")))).toEqual(
      expected,
    );
    // An unchanged call keeps its entry identity across derives.
    expect(deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-1"))[0]).toBe(finished[0]);
  });

  it("labels MCP servers from status events, with a cleaned-up fallback", () => {
    const call = (id: string, mcpServerName: string, sequence: number) =>
      makeActivity({
        id,
        sequence,
        turnId: "turn-1",
        kind: "tool.completed",
        payload: {
          itemType: "mcp_tool_call",
          providerItemId: id,
          status: "completed",
          mcpServerName,
          mcpToolName: "guide",
        },
      });
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "status",
          kind: "mcp.status.updated",
          tone: "info",
          summary: "MCP server claude.ai Claude Docs: ready",
          payload: { name: "claude.ai Claude Docs", status: "ready" },
        }),
        call("docs", "claude_ai_Claude_Docs", 2),
        call("thread", "f5_thread", 3),
        call("fs", "local_files", 4),
      ],
      TurnId.makeUnsafe("turn-1"),
    );
    expect(
      entries
        .filter((entry) => entry.itemType === "mcp_tool_call")
        .map((entry) => [entry.mcpServerName, entry.mcpServerLabel]),
    ).toEqual([
      ["claude_ai_Claude_Docs", "Claude Docs"],
      ["f5_thread", "F5 threads"],
      ["local_files", "Local files"],
    ]);
  });

  it("keeps a running MCP call's snapshot until it finishes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "mcp-updated",
          turnId: "turn-1",
          kind: "tool.updated",
          payload: { itemType: "mcp_tool_call", providerItemId: "mcp-1", status: "inProgress" },
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );
    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ["mcp-updated", "inProgress"],
    ]);
  });

  it.each(["computer", "preview"] as const)(
    "preserves %s run boundaries when intervening work leaves the historical log",
    (surface) => {
      const payload =
        surface === "computer"
          ? { computerTool: true, mcpToolName: "computer_click" }
          : { mcpServerName: "__f5_preview", mcpToolName: "preview_click" };
      const activities = [
        makeActivity({
          id: "first-run",
          sequence: 1,
          turnId: "turn-1",
          kind: "tool.completed",
          payload: { itemType: "mcp_tool_call", providerItemId: "first", ...payload },
        }),
        makeActivity({
          id: "intervening-command",
          sequence: 2,
          turnId: "turn-1",
          kind: "tool.completed",
          payload: { itemType: "dynamic_tool_call", command: "echo between runs" },
        }),
        makeActivity({
          id: "second-run",
          sequence: 3,
          turnId: "turn-1",
          kind: "tool.completed",
          payload: { itemType: "mcp_tool_call", providerItemId: "second", ...payload },
        }),
      ];
      const live = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-1"));
      const historical = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
      expect(historical.map((entry) => entry.id)).toEqual(["first-run", "second-run"]);
      expect(historical.map((entry) => entry.automationRunId)).toEqual([
        live[0]!.automationRunId,
        live[2]!.automationRunId,
      ]);
      expect(historical[0]!.automationRunId).not.toBe(historical[1]!.automationRunId);
      // Stable annotated objects let unrelated turns reuse existing timeline rows.
      expect(deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-3"))[0]).toBe(historical[0]);
    },
  );

  it.each(["completed", "inProgress"] as const)(
    "keeps a reused provider id in another turn separate when its status is %s",
    (status) => {
      const call = (id: string, turnId: string, tool: string, callStatus: string) =>
        makeActivity({
          id,
          turnId,
          sequence: turnId === "turn-1" ? 1 : 2,
          kind: callStatus === "inProgress" ? "tool.started" : "tool.completed",
          payload: {
            itemType: "mcp_tool_call",
            providerItemId: "reused-id",
            computerTool: true,
            mcpToolName: tool,
            status: callStatus,
          },
        });
      const entries = deriveWorkLogEntries(
        [
          call("old", "turn-1", "computer_click", "completed"),
          call(
            "new",
            "turn-2",
            status === "completed" ? "computer_click" : "computer_type",
            status,
          ),
        ],
        TurnId.makeUnsafe("turn-2"),
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ id: "old", turnId: "turn-1", status: "completed" });
      expect(entries[1]).toMatchObject({ id: "new", turnId: "turn-2", status });
    },
  );

  it("preserves correlated historical diagnostics and scopes them to their call's turn", () => {
    const activities = ["turn-1", "turn-2"].flatMap((turnId) => [
      makeActivity({
        id: turnId + "-call",
        turnId,
        kind: "tool.completed",
        sequence: turnId === "turn-1" ? 1 : 4,
        payload: {
          itemType: "mcp_tool_call",
          providerItemId: "reused",
          computerTool: true,
          mcpToolName: "computer_click",
        },
      }),
      makeActivity({
        id: turnId + "-hook",
        turnId,
        kind: "hook.completed",
        payload: {
          hookId: "reused-hook",
          providerItemId: "reused",
          rawStatus: "failed",
          outcome: "error",
        },
      }),
      makeActivity({
        id: turnId + "-review",
        turnId,
        kind: "approval-review.completed",
        payload: { reviewId: "reused-review", providerItemId: "reused", status: "denied" },
      }),
    ]);
    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-3"));
    expect(entries).toHaveLength(6);
    const timeline = deriveTimelineEntries([], [], entries);
    expect(timeline).toHaveLength(2);
    for (const row of timeline) {
      if (row.kind !== "work") throw new Error("Expected a work row");
      expect(row.entry.nestedDiagnostics?.map((entry) => entry.id).toSorted()).toEqual([
        row.entry.turnId + "-hook",
        row.entry.turnId + "-review",
      ]);
    }
    const legacy = makeActivity({
      id: "ambiguous-legacy-hook",
      kind: "hook.completed",
      payload: { hookId: "legacy", providerItemId: "reused", rawStatus: "failed" },
    });
    const withLegacy = deriveTimelineEntries(
      [],
      [],
      deriveWorkLogEntries([...activities, legacy], undefined),
    );
    expect(withLegacy.some((row) => row.id === legacy.id)).toBe(true);
  });

  it("keeps collaboration rows without provider item ids on the generic path", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "collab-no-id-started",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.started",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            codexCollaborationTool: "sendInput",
            subagentSenderThreadId: "parent",
            subagentReceiverThreadIds: ["agent-a"],
          },
        }),
        makeActivity({
          id: "collab-no-id-completed",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            codexCollaborationTool: "sendInput",
            subagentSenderThreadId: "parent",
            subagentReceiverThreadIds: ["agent-a"],
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "collab-no-id-started",
      "collab-no-id-completed",
    ]);
  });

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

  it("retains a valid historical MCP app and its turn correlation", () => {
    const payload = {
      reference: {
        attachmentId: "app-document",
        server: "weather",
        tool: "forecast",
        resourceUri: "ui://weather/app",
      },
      arguments: { city: "Berlin" },
      result: { content: [{ type: "text", text: "Sunny" }] },
    };
    const entries = deriveWorkLogEntries(
      [
        makeActivity({ id: "app", kind: "mcpApp", turnId: "old-turn", payload }),
        makeActivity({ id: "broken-app", kind: "mcpApp", turnId: "old-turn", payload: {} }),
      ],
      TurnId.makeUnsafe("new-turn"),
    );
    expect(entries.find((entry) => entry.id === "app")).toMatchObject({
      turnId: "old-turn",
      mcpApp: payload,
    });
    expect(entries.find((entry) => entry.id === "broken-app")?.mcpApp).toBeUndefined();
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

  describe("usage limits", () => {
    const resetsAt = "2026-10-08T18:10:00.000Z";
    const usageLimit = { provider: "claudeAgent", windowLabel: "5-hour", resetsAt };
    const message = `Claude 5-hour usage limit reached. Resets at ${resetsAt}.`;

    it("merges the warning and the turn error into one neutral row in local time", () => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "limit-warning",
            createdAt: "2026-10-08T16:28:19.000Z",
            kind: "runtime.warning",
            summary: "Runtime warning",
            tone: "info",
            turnId: "turn-limit",
            payload: { message, detail: { rateLimitType: "five_hour" }, usageLimit },
          }),
          makeActivity({
            id: "limit-error",
            createdAt: "2026-10-08T16:28:20.000Z",
            kind: "runtime.error",
            summary: "Runtime error",
            tone: "error",
            turnId: "turn-limit",
            payload: { message, usageLimit },
          }),
        ],
        undefined,
        { runtimeWarningVisibility: "hidden" },
      );

      expect(entries.map((entry) => entry.id)).toEqual(["limit-error"]);
      expect(entries[0]?.label).toBe(
        `Claude 5-hour limit reached · resets ${formatUsageResumeTime(resetsAt)}`,
      );
      expect(entries[0]?.tone).toBe("info");
      expect(entries[0]?.isIssue).toBe(true);
    });

    it("shows one row for several exhausted windows, using the error's combined reset", () => {
      const weeklyReset = "2026-10-10T09:00:00.000Z";
      const warning = (id: string, windowLabel: string, reset: string) =>
        makeActivity({
          id,
          kind: "runtime.warning",
          summary: "Runtime warning",
          tone: "info",
          turnId: "turn-multi",
          payload: {
            message,
            usageLimit: { provider: "claudeAgent", windowLabel, resetsAt: reset },
          },
        });
      const warnings = [
        warning("five-hour-warning", "5-hour", resetsAt),
        warning("weekly-warning", "7-day", weeklyReset),
      ];

      const running = deriveWorkLogEntries(warnings, undefined);
      expect(running.map((entry) => entry.id)).toEqual(["weekly-warning"]);

      const failed = deriveWorkLogEntries(
        [
          ...warnings,
          makeActivity({
            id: "multi-error",
            createdAt: "2026-02-23T00:00:01.000Z",
            kind: "runtime.error",
            summary: "Runtime error",
            tone: "error",
            turnId: "turn-multi",
            payload: {
              message,
              usageLimit: { provider: "claudeAgent", windowLabel: "7-day", resetsAt: weeklyReset },
            },
          }),
        ],
        undefined,
      );
      expect(failed.map((entry) => entry.label)).toEqual([
        `Claude 7-day limit reached · resets ${formatUsageResumeTime(weeklyReset)}`,
      ]);
    });

    it("turns a usage-limit error without a warning into the neutral row", () => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "codex-limit-error",
            kind: "runtime.error",
            summary: "Runtime error",
            tone: "error",
            turnId: "turn-codex",
            payload: {
              message: "Codex usage limit reached.",
              usageLimit: { provider: "codex", windowLabel: null, resetsAt: null },
            },
          }),
        ],
        undefined,
      );

      expect(entries.map((entry) => [entry.label, entry.tone])).toEqual([
        ["Codex usage limit reached", "info"],
      ]);
    });

    it("keeps the old label for a legacy warning without display fields", () => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "legacy-warning",
            kind: "runtime.warning",
            summary: "Runtime warning",
            tone: "info",
            turnId: "turn-legacy",
            payload: { message, detail: { rateLimitType: "five_hour" } },
          }),
        ],
        undefined,
        { runtimeWarningVisibility: "full" },
      );

      expect(entries.map((entry) => entry.label)).toEqual([message]);
    });
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

  it("hides cross-version Codex model-cache warnings even when visibility is full", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        createdAt: "2026-08-20T14:48:43.142Z",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message:
            "2026-08-20T14:48:43.142211Z ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_parallel_tool_calls` at line 4921 column 5",
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

  it("keeps Essential mode concise while retaining actionable hook, review, and guardian issues", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "hook-success",
        kind: "hook.completed",
        summary: "preToolUse hook (completed)",
        tone: "info",
        payload: { hookId: "hook-success", hookEvent: "preToolUse", rawStatus: "completed" },
      }),
      makeActivity({
        id: "hook-blocked",
        kind: "hook.completed",
        summary: "preToolUse hook (blocked)",
        tone: "error",
        payload: { hookId: "hook-blocked", hookEvent: "preToolUse", rawStatus: "blocked" },
      }),
      makeActivity({
        id: "review-approved",
        kind: "approval-review.completed",
        summary: "command review approved",
        tone: "info",
        payload: { reviewId: "review-approved", status: "approved", actionType: "command" },
      }),
      makeActivity({
        id: "review-denied",
        kind: "approval-review.completed",
        summary: "command review denied",
        tone: "error",
        payload: { reviewId: "review-denied", status: "denied", actionType: "command" },
      }),
      makeActivity({
        id: "guardian-warning",
        kind: "runtime.warning",
        summary: "Guardian warning",
        tone: "error",
        payload: {
          message: "Review the requested network access",
          category: "guardian",
          actionable: true,
        },
      }),
      makeActivity({
        id: "hook-unmatched",
        kind: "hook.started",
        summary: "Running postToolUse hook",
        tone: "info",
        payload: { hookId: "hook-unmatched", hookEvent: "postToolUse" },
      }),
      makeActivity({
        id: "review-unmatched",
        kind: "approval-review.started",
        summary: "Reviewing command",
        tone: "info",
        payload: { reviewId: "review-unmatched", status: "inProgress", actionType: "command" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      mode: "essential",
      runtimeWarningVisibility: "hidden",
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "guardian-warning",
      "hook-blocked",
      "hook-unmatched",
      "review-denied",
      "review-unmatched",
    ]);
    expect(entries.every((entry) => entry.isIssue)).toBe(true);
    expect(entries.find((entry) => entry.id === "hook-unmatched")?.diagnostic?.status).toBe(
      "incomplete",
    );
    expect(entries.find((entry) => entry.id === "review-unmatched")?.diagnostic?.status).toBe(
      "incomplete",
    );
  });

  it("uses normalized hook outcomes instead of stopped raw status for issue severity", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "hook-output-replaced",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "hook.completed",
        summary: "postToolUse hook applied output replacement",
        tone: "info",
        payload: {
          hookId: "hook-output-replaced",
          hookEvent: "postToolUse",
          outcome: "success",
          rawStatus: "stopped",
        },
      }),
      makeActivity({
        id: "hook-cancelled",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "hook.completed",
        summary: "preToolUse hook (stopped)",
        tone: "info",
        payload: {
          hookId: "hook-cancelled",
          hookEvent: "preToolUse",
          outcome: "cancelled",
          rawStatus: "stopped",
        },
      }),
      makeActivity({
        id: "hook-output-replaced-legacy",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "hook.completed",
        summary: "post_tool_use hook (stopped)",
        tone: "info",
        payload: {
          hookId: "hook-output-replaced-legacy",
          hookEvent: "post_tool_use",
          outcome: "cancelled",
          rawStatus: "stopped",
        },
      }),
    ];

    const diagnostics = deriveWorkLogEntries(activities, undefined, {
      mode: "diagnostics",
      filter: "hooks",
    });
    expect(diagnostics.find((entry) => entry.id === "hook-output-replaced")).toMatchObject({
      label: "postToolUse hook applied output replacement",
      isIssue: false,
      diagnostic: { status: "stopped", outcome: "success" },
    });
    expect(diagnostics.find((entry) => entry.id === "hook-cancelled")).toMatchObject({
      isIssue: true,
      diagnostic: { status: "stopped", outcome: "cancelled" },
    });
    expect(diagnostics.find((entry) => entry.id === "hook-output-replaced-legacy")).toMatchObject({
      label: "post_tool_use hook applied output replacement",
      isIssue: false,
      diagnostic: { status: "stopped", outcome: "success" },
    });

    const essential = deriveWorkLogEntries(activities, undefined, { mode: "essential" });
    expect(essential.map((entry) => entry.id)).toEqual(["hook-cancelled"]);
  });

  it("pairs legacy diagnostic starts, preserves completed handlers, and marks unmatched starts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "hook-start-matched",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "hook.started",
        summary: "Running preToolUse hook",
        tone: "info",
        payload: { hookId: "hook-1", hookEvent: "preToolUse" },
      }),
      makeActivity({
        id: "hook-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "hook.completed",
        summary: "preToolUse hook (completed)",
        tone: "info",
        payload: {
          hookId: "hook-1",
          hookEvent: "preToolUse",
          handlerType: "command",
          displayOrder: 2,
          durationMs: 17,
          rawStatus: "completed",
        },
      }),
      makeActivity({
        id: "hook-start-unmatched",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "hook.started",
        summary: "Running postToolUse hook",
        tone: "info",
        payload: { hookId: "hook-2", hookEvent: "postToolUse" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      mode: "diagnostics",
      filter: "hooks",
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: "hook-completed",
      diagnostic: {
        type: "hook",
        id: "hook-1",
        status: "completed",
        handlerType: "command",
        displayOrder: 2,
        durationMs: 17,
      },
    });
    expect(entries[1]).toMatchObject({
      id: "hook-start-unmatched",
      label: "postToolUse (incomplete)",
      isIssue: true,
      diagnostic: { status: "incomplete", incomplete: true },
    });
  });

  it("applies All, Tools, Hooks, and Issues filters to diagnostics", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool",
        kind: "tool.completed",
        summary: "Read file",
        payload: { itemType: "dynamic_tool_call", providerItemId: "tool-1" },
      }),
      makeActivity({
        id: "hook-success",
        kind: "hook.completed",
        summary: "Hook completed",
        tone: "info",
        payload: { hookId: "hook-success", rawStatus: "completed" },
      }),
      makeActivity({
        id: "hook-failed",
        kind: "hook.completed",
        summary: "Hook failed",
        tone: "error",
        payload: { hookId: "hook-failed", rawStatus: "failed" },
      }),
      makeActivity({
        id: "warning",
        kind: "runtime.warning",
        summary: "Protocol warning",
        tone: "info",
        payload: { message: "Unsupported event", category: "protocol", actionable: true },
      }),
    ];

    const idsFor = (filter: "all" | "tools" | "hooks" | "issues") =>
      deriveWorkLogEntries(activities, undefined, { mode: "diagnostics", filter }).map(
        (entry) => entry.id,
      );

    expect(idsFor("all")).toEqual(["hook-failed", "hook-success", "tool", "warning"]);
    expect(idsFor("tools")).toEqual(["tool"]);
    expect(idsFor("hooks")).toEqual(["hook-failed", "hook-success"]);
    expect(idsFor("issues")).toEqual(["hook-failed", "warning"]);
  });

  it("coalesces identical protocol warnings with a count", () => {
    const activities = ["one", "two", "three"].map((id, index) =>
      makeActivity({
        id,
        createdAt: `2026-02-23T00:00:0${index + 1}.000Z`,
        kind: "runtime.warning",
        summary: "Protocol warning",
        tone: "info",
        payload: {
          message: "Unsupported Codex notification: future/event",
          category: "protocol",
          actionable: true,
        },
      }),
    );
    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "hidden",
    });
    expect(entries).toEqual([
      expect.objectContaining({
        id: "one",
        label: "Unsupported Codex notification: future/event",
        warningCount: 3,
      }),
    ]);
  });

  it("keeps protocol warnings with different methods or values distinct", () => {
    const activities = [
      makeActivity({
        id: "one",
        kind: "runtime.warning",
        summary: "Protocol warning",
        tone: "info",
        payload: {
          message: "Malformed Codex event",
          category: "protocol",
          actionable: true,
          protocolMethod: "item/completed",
          protocolValue: "subAgentActivity",
        },
      }),
      makeActivity({
        id: "two",
        kind: "runtime.warning",
        summary: "Protocol warning",
        tone: "info",
        payload: {
          message: "Malformed Codex event",
          category: "protocol",
          actionable: true,
          protocolMethod: "item/reasoning/summaryPartAdded",
          protocolValue: "futureItem",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "hidden",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(entries.every((entry) => entry.warningCount === undefined)).toBe(true);
  });

  it("keeps repeated guardian warnings individually inspectable", () => {
    const activities = ["guardian-one", "guardian-two"].map((id, index) =>
      makeActivity({
        id,
        createdAt: `2026-02-23T00:00:0${index + 1}.000Z`,
        kind: "runtime.warning",
        summary: "Guardian warning",
        tone: "error",
        payload: {
          message: "Review network access",
          category: "guardian",
          actionable: true,
        },
      }),
    );
    const entries = deriveWorkLogEntries(activities, undefined, {
      runtimeWarningVisibility: "hidden",
    });
    expect(entries.map((entry) => entry.id)).toEqual(["guardian-one", "guardian-two"]);
    expect(entries.every((entry) => entry.warningCount === undefined)).toBe(true);
  });

  it.each([false, true])(
    "deduplicates subagent completion pairs with intervening activity: %s",
    (intervening) => {
      const activities = [0, 1].map((index) =>
        makeActivity({
          id: `completed-${index}`,
          createdAt: `2026-09-23T18:21:12.49${index * 2}Z`,
          kind: "subagent.activity",
          summary: "Subagent completed",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "subagent-completed-agent-1",
            title: "Subagent completed",
            subagentType: "completed",
            subagentThreadId: "agent-1",
            subagentPath: "/root/reviewer",
          },
        }),
      );
      if (intervening) {
        activities.splice(
          1,
          0,
          makeActivity({
            id: "another-agent",
            createdAt: "2026-09-23T18:21:12.491Z",
            kind: "subagent.activity",
            summary: "Subagent completed",
            payload: {
              itemType: "collab_agent_tool_call",
              providerItemId: "subagent-completed-agent-2",
              subagentType: "completed",
              subagentThreadId: "agent-2",
              subagentPath: "/root/other",
            },
          }),
        );
      }
      const entries = deriveWorkLogEntries(activities, undefined);
      expect(entries).toHaveLength(intervening ? 2 : 1);
      if (intervening) expect(entries.some((entry) => entry.id === "another-agent")).toBe(true);
      expect(entries.find((entry) => entry.subagentThreadId === "agent-1")).toMatchObject({
        label: "Subagent completed",
        subagentType: "completed",
        subagentThreadId: "agent-1",
        subagentPath: "/root/reviewer",
      });
    },
  );

  it("correlates subagent activity with the existing collaboration row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "collab",
          kind: "tool.completed",
          summary: "Subagent activity",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "collab-call-1",
            data: {
              item: {
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                receiverThreadIds: ["agent-thread-1"],
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-activity",
          kind: "subagent.activity",
          summary: "Subagent interacted",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "subagent-activity-1",
            subagentType: "interacted",
            subagentThreadId: "agent-thread-1",
            subagentPath: "/root/reviewer",
          },
        }),
      ],
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "collab",
      subagentThreadId: "agent-thread-1",
      subagentPath: "/root/reviewer",
    });
  });

  it("correlates subagent activity only to a preceding spawn row", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "spawn-started",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Spawn agent",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "spawn-call",
            data: {
              item: {
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                receiverThreadIds: ["agent-thread-1"],
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-started",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "subagent.activity",
          summary: "Subagent started",
          payload: {
            itemType: "collab_agent_tool_call",
            subagentThreadId: "agent-thread-1",
            subagentPath: "/root/reviewer",
          },
        }),
        makeActivity({
          id: "spawn-completed",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "tool.completed",
          summary: "Spawn agent",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "spawn-call",
            data: {
              item: {
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                receiverThreadIds: ["agent-thread-1"],
              },
            },
          },
        }),
        makeActivity({
          id: "send-input",
          createdAt: "2026-02-23T00:00:04.000Z",
          kind: "tool.completed",
          summary: "Send input",
          payload: {
            itemType: "collab_agent_tool_call",
            providerItemId: "send-call",
            data: {
              item: {
                type: "collabAgentToolCall",
                tool: "sendInput",
                receiverThreadIds: ["agent-thread-1"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries.map((entry) => entry.id)).toEqual(["spawn-completed", "send-input"]);
    expect(entries[0]).toMatchObject({
      subagentThreadId: "agent-thread-1",
      subagentPath: "/root/reviewer",
    });
    expect(entries[1]?.subagentPath).toBeUndefined();
  });

  it("nests correlated diagnostics under tool and command rows with standalone fallback", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "tool",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.completed",
          summary: "Read file",
          payload: {
            itemType: "dynamic_tool_call",
            providerItemId: "tool-item-1",
          },
        }),
        makeActivity({
          id: "tool-hook",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "hook.completed",
          summary: "postToolUse hook (completed)",
          payload: {
            hookId: "hook-tool",
            hookEvent: "postToolUse",
            rawStatus: "completed",
            providerItemId: "tool-item-1",
          },
        }),
        makeActivity({
          id: "command-hook",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "hook.completed",
          summary: "postToolUse hook (completed)",
          payload: {
            hookId: "hook-command",
            hookEvent: "postToolUse",
            rawStatus: "completed",
            providerItemId: "command-item-1",
          },
        }),
        makeActivity({
          id: "orphan-hook",
          createdAt: "2026-02-23T00:00:04.000Z",
          kind: "hook.completed",
          summary: "stop hook (completed)",
          payload: { hookId: "hook-orphan", hookEvent: "stop", rawStatus: "completed" },
        }),
      ],
      undefined,
      { mode: "diagnostics" },
    );
    const timeline = deriveTimelineEntries([], [], workEntries, [
      {
        id: OrchestrationCommandExecutionId.makeUnsafe("command-row-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        providerItemId: ProviderItemId.makeUnsafe("command-item-1"),
        command: "bun run lint",
        title: "Run lint",
        status: "completed",
        detail: null,
        exitCode: 0,
        startedAt: "2026-02-23T00:00:01.500Z",
        completedAt: "2026-02-23T00:00:03.500Z",
        updatedAt: "2026-02-23T00:00:03.500Z",
        startedSequence: 1,
        lastUpdatedSequence: 2,
      },
    ]);
    const toolRow = timeline.find((entry) => entry.kind === "work" && entry.entry.id === "tool");
    const commandRow = timeline.find((entry) => entry.kind === "command");
    const orphanRow = timeline.find(
      (entry) => entry.kind === "work" && entry.entry.id === "orphan-hook",
    );
    expect(toolRow?.kind === "work" ? toolRow.entry.nestedDiagnostics?.[0]?.id : null).toBe(
      "tool-hook",
    );
    expect(commandRow?.kind === "command" ? commandRow.nestedDiagnostics?.[0]?.id : null).toBe(
      "command-hook",
    );
    expect(orphanRow).toBeDefined();
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

  describe("same-millisecond Claude tool-result lifecycle", () => {
    // Claude emits its final `item.updated` (inProgress) and `item.completed`
    // in the same millisecond; activities carry no sequence, so the sort tie
    // falls back to the random activity id.
    const claudeFileChangeLifecycle = (ids: {
      readonly updated: string;
      readonly completed: string;
      readonly updatedDetail?: string;
      readonly terminalStatus?: "completed" | "failed" | "declined";
      readonly updatedCreatedAt?: string;
    }) => {
      const turnId = TurnId.makeUnsafe("turn-claude-edit");
      const payload = (status: string, detail: string) => ({
        itemType: "file_change",
        providerItemId: "toolu_claude_write",
        status,
        title: "File change",
        detail,
        requestKind: "file-change",
        changedFiles: ["/repo/src/greet.ts"],
        fileChangeId: "filechange:thread-1:toolu_claude_write",
      });
      const activities = [
        makeActivity({
          id: "claude-edit-started",
          turnId,
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.started",
          summary: "File change started",
          payload: payload("inProgress", "Write: {}"),
        }),
        makeActivity({
          id: ids.updated,
          turnId,
          createdAt: ids.updatedCreatedAt ?? "2026-02-23T00:00:02.000Z",
          kind: "tool.updated",
          summary: "File change",
          payload: payload("inProgress", ids.updatedDetail ?? "/repo/src/greet.ts"),
        }),
        makeActivity({
          id: ids.completed,
          turnId,
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "File change",
          payload: payload(ids.terminalStatus ?? "completed", "/repo/src/greet.ts"),
        }),
      ];
      return deriveWorkLogEntries(activities, turnId);
    };

    it.each(["failed", "declined"] as const)(
      "keeps the %s entry when the stale update sorts after it",
      (terminalStatus) => {
        const entries = claudeFileChangeLifecycle({
          completed: "a-completed",
          updated: "b-updated",
          updatedDetail: "Write: {}",
          terminalStatus,
        });

        expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
          ["a-completed", terminalStatus],
        ]);
      },
    );

    it("keeps an in-progress update stamped after the terminal entry", () => {
      // e.g. a Claude task backgrounded after its tool result was reported.
      const entries = claudeFileChangeLifecycle({
        completed: "a-completed",
        updated: "b-updated",
        updatedDetail: "Write: {}",
        updatedCreatedAt: "2026-02-23T00:00:03.000Z",
      });

      expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
        ["a-completed", "completed"],
        ["b-updated", "inProgress"],
      ]);
    });

    it("keeps the current turn's in-progress entry when an earlier turn completed the same item id", () => {
      const previousTurnId = TurnId.makeUnsafe("turn-previous");
      const currentTurnId = TurnId.makeUnsafe("turn-current");
      const payload = (status: string) => ({
        itemType: "file_change",
        providerItemId: "reused-item-id",
        status,
        title: "File change",
        detail: "/repo/src/greet.ts",
        requestKind: "file-change",
        changedFiles: ["/repo/src/greet.ts"],
      });
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: "previous-completed",
            turnId: previousTurnId,
            createdAt: "2026-02-23T00:00:01.000Z",
            kind: "tool.completed",
            summary: "File change",
            payload: payload("completed"),
          }),
          makeActivity({
            id: "current-updated",
            turnId: currentTurnId,
            createdAt: "2026-02-23T00:01:00.000Z",
            kind: "tool.updated",
            summary: "File change",
            payload: payload("inProgress"),
          }),
        ],
        currentTurnId,
      );

      expect(entries.map((entry) => [entry.id, entry.status])).toContainEqual([
        "current-updated",
        "inProgress",
      ]);
    });

    it("keeps the completed entry when the stale update sorts after it", () => {
      const entries = claudeFileChangeLifecycle({ completed: "a-completed", updated: "b-updated" });

      expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
        ["a-completed", "completed"],
      ]);
    });

    it("keeps the completed entry when the update sorts first", () => {
      const entries = claudeFileChangeLifecycle({ updated: "a-updated", completed: "b-completed" });

      expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
        ["b-completed", "completed"],
      ]);
    });

    it("drops a stale update after completion even when its visible snapshot differs", () => {
      const entries = claudeFileChangeLifecycle({
        completed: "a-completed",
        updated: "b-updated",
        updatedDetail: "Write: {}",
      });

      expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
        ["a-completed", "completed"],
      ]);
    });
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
  describe("message-mode answers", () => {
    const answerCard = {
      id: "user-input-resolved:cmd",
      createdAt: "2026-02-23T00:00:02.000Z",
      label: "User input submitted",
      tone: "info" as const,
      userInput: {
        state: "answered" as const,
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Ready?",
            answers: [{ text: "Yes", custom: false }],
          },
        ],
        answerMessageId: "answer:cmd",
      },
    };
    const answerMessage = (
      overrides: Partial<Pick<ChatMessage, "id" | "text" | "attachments">> = {},
    ): ChatMessage => ({
      id: MessageId.makeUnsafe("answer:cmd"),
      role: "user",
      text: '{"0":{"answers":["Yes"]}}',
      createdAt: "2026-02-23T00:00:02.001Z",
      streaming: false,
      ...overrides,
    });
    const messageEntry = (entries: ReturnType<typeof deriveTimelineEntries>, id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      return entry?.kind === "message" ? entry : undefined;
    };
    const workEntry = (entries: ReturnType<typeof deriveTimelineEntries>, id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      return entry?.kind === "work" ? entry.entry : undefined;
    };

    it("renders the card on the answer's own user row, which keeps the turn boundary", () => {
      const entries = deriveTimelineEntries([answerMessage()], [], [answerCard]);
      expect(entries.map((entry) => [entry.id, entry.kind])).toEqual([["answer:cmd", "message"]]);
      expect(messageEntry(entries, "answer:cmd")?.userInput?.questions[0]?.answers).toEqual([
        { text: "Yes", custom: false },
      ]);
    });

    it("shows the answers an edited or retried delivery actually carried", () => {
      const entries = deriveTimelineEntries(
        [
          answerMessage({
            id: MessageId.makeUnsafe("answer:cmd#retry"),
            text: '{"0":{"answers":["Yes","Only after lunch"]}}',
          }),
        ],
        [],
        [answerCard],
      );
      expect(entries.map((entry) => entry.id)).toEqual(["answer:cmd#retry"]);
      expect(messageEntry(entries, "answer:cmd#retry")?.userInput?.questions[0]?.answers).toEqual([
        { text: "Yes", custom: false },
        { text: "Only after lunch", custom: true },
      ]);
    });

    it("keeps a bubble beside the card for attachments or a rewritten reply", () => {
      const withFile = deriveTimelineEntries(
        [
          answerMessage({
            attachments: [
              {
                type: "file",
                id: "file-1",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ],
          }),
        ],
        [],
        [answerCard],
      );
      expect(withFile.map((entry) => entry.id)).toEqual(["user-input-resolved:cmd", "answer:cmd"]);
      expect(messageEntry(withFile, "answer:cmd")?.userInput).toBeUndefined();

      const rewritten = deriveTimelineEntries(
        [answerMessage({ text: "Actually, not yet." })],
        [],
        [answerCard],
      );
      expect(rewritten.map((entry) => entry.id)).toEqual(["user-input-resolved:cmd", "answer:cmd"]);
      const card = workEntry(rewritten, "user-input-resolved:cmd")?.userInput;
      expect(card?.state).toBe("answered");
      expect(card?.questions[0]?.answers).toEqual([]);
    });

    it("folds a card into one delivered message only", () => {
      const entries = deriveTimelineEntries(
        [
          answerMessage(),
          answerMessage({
            id: MessageId.makeUnsafe("answer:cmd#duplicate"),
          }),
        ],
        [],
        [answerCard],
      );
      expect(entries.map((entry) => entry.id)).toEqual(["answer:cmd", "answer:cmd#duplicate"]);
      expect(messageEntry(entries, "answer:cmd")?.userInput).toBeDefined();
      expect(messageEntry(entries, "answer:cmd#duplicate")?.userInput).toBeUndefined();
    });

    it("keeps the card standalone until its answer is delivered", () => {
      const entries = deriveTimelineEntries([], [], [answerCard]);
      expect(entries.map((entry) => entry.id)).toEqual(["user-input-resolved:cmd"]);
      expect(deriveTimelineEntries([answerMessage()], [], []).map((entry) => entry.id)).toEqual([
        "answer:cmd",
      ]);
    });
  });

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

  it("drops the background status suffix from command row labels", () => {
    const makeExecution = (id: string, command: string, title: string) => ({
      id: OrchestrationCommandExecutionId.makeUnsafe(id),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      providerItemId: null,
      command,
      title,
      status: "completed" as const,
      detail: null,
      exitCode: 0,
      startedAt: "2026-03-20T10:00:00.000Z",
      completedAt: "2026-03-20T10:00:01.000Z",
      updatedAt: "2026-03-20T10:00:01.000Z",
      startedSequence: 1,
      lastUpdatedSequence: 2,
    });
    const entries = deriveTimelineEntries(
      [],
      [],
      [],
      [
        makeExecution(
          "cmdexec:thread-1:item-read-bg",
          "/bin/zsh -lc 'sed -n \"12p\" apps/web/src/a.ts'",
          "Read config — completed",
        ),
        makeExecution(
          "cmdexec:thread-1:item-search-bg",
          "rg -n needle apps",
          "Searching apps for needle — completed",
        ),
        makeExecution(
          "cmdexec:thread-1:item-search-generic-bg",
          "rg -n other packages",
          "Command run — completed",
        ),
      ],
    );

    expect(
      entries.map((entry) => (entry.kind === "work" ? entry.entry.label : entry.kind)),
    ).toEqual(["Read config", "Searching apps for needle", "Searching packages for other"]);
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
  it("advertises built-in providers that become selectable when probes pass", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    const grok = PROVIDER_OPTIONS.find((option) => option.value === "grok");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "cursor", label: "Cursor", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "grok", label: "Grok", available: true },
      { value: "antigravity", label: "Antigravity", available: true },
      { value: "muse", label: "Muse Code", available: true },
      { value: "acp", label: "Custom ACP agent", available: true },
      { value: "pi", label: "Pi", available: true },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(grok).toEqual({
      value: "grok",
      label: "Grok",
      available: true,
    });
  });
});

it("derives skill names for old tool history and live tool headings", () => {
  const activity = makeActivity({
    id: "skill-history",
    turnId: "turn-skill",
    payload: {
      itemType: "dynamic_tool_call",
      providerItemId: "skill-call",
      title: "Tool call",
      data: { toolName: "Skill", input: { skill: "team:review" } },
    },
  });
  expect(
    deriveWorkLogEntries([{ ...activity, kind: "tool.completed" }], undefined)[0]?.toolTitle,
  ).toBe("Skill: team:review");
  expect(deriveLiveWorkActivity([activity], TurnId.makeUnsafe("turn-skill"))).toMatchObject({
    kind: "tool",
    title: "Skill: team:review",
  });
});

describe("work log entry reuse", () => {
  const toolActivity = (index: number) =>
    makeActivity({
      id: `stable-tool-${index}`,
      kind: "tool.completed",
      summary: "Ran command",
      tone: "tool",
      turnId: "turn-stable",
      sequence: index,
      payload: {
        itemType: "command_execution",
        providerItemId: `stable-tool-${index}`,
        title: "Ran command",
        status: "completed",
        detail: `git status ${index}`,
      },
    });

  it("reuses entries for unchanged activities when one is appended", () => {
    const activities = [0, 1, 2].map(toolActivity);
    const initial = deriveWorkLogEntries(activities.slice(0, 2), undefined);
    const appended = deriveWorkLogEntries(activities, undefined);

    expect(appended).toHaveLength(3);
    expect(appended[0]).toBe(initial[0]);
    expect(appended[1]).toBe(initial[1]);
  });

  it("rebuilds a warning row when the warning visibility changes", () => {
    const warning = makeActivity({
      id: "visible-warning",
      kind: "runtime.warning",
      summary: "Runtime warning",
      tone: "info",
      payload: { message: "Config file ignored" },
    });

    expect(
      deriveWorkLogEntries([warning], undefined, { runtimeWarningVisibility: "summarized" })[0]
        ?.label,
    ).toBe("Runtime warning");
    expect(
      deriveWorkLogEntries([warning], undefined, { runtimeWarningVisibility: "full" })[0]?.label,
    ).toBe("Config file ignored");
  });

  it("rebuilds an answered input row once its question arrives", () => {
    const resolved = makeActivity({
      id: "input-resolved",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "user-input.resolved",
      summary: "User input submitted",
      tone: "info",
      payload: { requestId: "req-1", answers: { choice: "Yes" } },
    });
    const requested = makeActivity({
      id: "input-requested",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "user-input.requested",
      summary: "User input requested",
      tone: "info",
      payload: {
        requestId: "req-1",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Proceed?",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      },
    });

    expect(
      deriveWorkLogEntries([resolved], undefined).find((entry) => entry.id === resolved.id)?.label,
    ).toBe("User input submitted");
    expect(
      deriveWorkLogEntries([requested, resolved], undefined).find(
        (entry) => entry.id === resolved.id,
      ),
    ).toMatchObject({ label: "Proceed?", detail: "Yes" });
  });
});

describe("runtime errors in the work log", () => {
  const retainedMessage =
    "ERROR codex_core::codex: failed to load skill /repo/.agent/skills/scaffolding/SKILL.md: invalid YAML: mapping va...";
  const runtimeError = (payload: Record<string, unknown>) =>
    makeActivity({
      id: "runtime-error",
      kind: "runtime.error",
      summary: "Runtime error",
      tone: "error",
      turnId: "turn-1",
      payload,
    });

  it("shows the retained error message as the detail of the generic row", () => {
    const [entry] = deriveWorkLogEntries([runtimeError({ message: retainedMessage })], undefined);

    expect(entry).toMatchObject({ label: "Runtime error", detail: retainedMessage });
  });

  it("keeps an explicit detail when the error has one", () => {
    const [entry] = deriveWorkLogEntries(
      [runtimeError({ message: retainedMessage, detail: "Run claude auth login." })],
      undefined,
    );

    expect(entry?.detail).toBe("Run claude auth login.");
  });

  it("does not repeat a message that matches the label", () => {
    const [entry] = deriveWorkLogEntries([runtimeError({ message: "Runtime  error" })], undefined);

    expect(entry?.detail).toBeUndefined();
  });

  it("does not read a message from other activity kinds", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "read-file",
          kind: "tool.completed",
          summary: "Read file",
          payload: { message: retainedMessage },
        }),
      ],
      undefined,
    );

    expect(entry?.detail).toBeUndefined();
  });
});
