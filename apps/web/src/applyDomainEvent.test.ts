import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";

import { applyDomainEvent } from "./applyDomainEvent";
import type { AppState } from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    model: "gpt-5-codex",
    createdAt: "2026-04-01T09:00:00.000Z",
    expanded: true,
    scripts: [],
    memories: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-01T09:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-04-01T09:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    lastVisitedAt: "2026-04-01T09:00:00.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    projects: [makeProject()],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [makeThread()],
    threadsHydrated: true,
    lastAppliedSequence: 0,
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: {},
    ...overrides,
  };
}

function makeEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  overrides: Partial<OrchestrationEvent> = {},
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: type.startsWith("project.") ? "project" : "thread",
    aggregateId:
      "projectId" in payload
        ? (payload.projectId ?? ProjectId.makeUnsafe("project-1"))
        : "threadId" in payload
          ? payload.threadId
          : ThreadId.makeUnsafe("thread-1"),
    occurredAt: "2026-04-01T09:05:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as OrchestrationEvent;
}

describe("applyDomainEvent", () => {
  it("marks newly created threads as detail-ready", () => {
    const next = applyDomainEvent(
      makeState({ threads: [] }),
      makeEvent("thread.created", {
        threadId: ThreadId.makeUnsafe("thread-created"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Created thread",
        model: "gpt-5-codex",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        threadReferences: [],
        createdAt: "2026-04-01T09:00:00.000Z",
        updatedAt: "2026-04-01T09:00:00.000Z",
      }),
    );

    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages).toEqual([]);
  });

  it("merges assistant message deltas into the target thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const messageId = MessageId.makeUnsafe("assistant-1");
    const initialState = makeState({
      threads: [
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            orchestrationStatus: "running",
            activeTurnId: turnId,
            createdAt: "2026-04-01T09:04:00.000Z",
            updatedAt: "2026-04-01T09:04:00.000Z",
          },
        }),
      ],
    });

    const afterStart = applyDomainEvent(
      initialState,
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "Hel",
        reasoningText: "thi",
        attachments: undefined,
        turnId,
        streaming: true,
        createdAt: "2026-04-01T09:04:01.000Z",
        updatedAt: "2026-04-01T09:04:01.000Z",
      }),
    );
    const afterComplete = applyDomainEvent(
      afterStart,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId,
          role: "assistant",
          text: "Hello",
          reasoningText: "thinking",
          attachments: undefined,
          turnId,
          streaming: false,
          createdAt: "2026-04-01T09:04:01.000Z",
          updatedAt: "2026-04-01T09:04:02.000Z",
        },
        {
          sequence: 2,
          occurredAt: "2026-04-01T09:05:02.000Z",
        },
      ),
    );

    expect(afterComplete.threads[0]?.messages).toEqual([
      {
        id: messageId,
        role: "assistant",
        text: "Hello",
        reasoningText: "thinking",
        turnId,
        createdAt: "2026-04-01T09:04:01.000Z",
        completedAt: "2026-04-01T09:04:02.000Z",
        streaming: false,
      },
    ]);
    expect(afterComplete.threads[0]?.latestTurn).toEqual({
      turnId,
      state: "completed",
      requestedAt: "2026-04-01T09:04:01.000Z",
      startedAt: "2026-04-01T09:04:01.000Z",
      completedAt: "2026-04-01T09:04:02.000Z",
      assistantMessageId: messageId,
    });
    expect(afterComplete.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:05:02.000Z");
  });

  it("estimates thread token usage from message traffic when the provider does not report it", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            session: {
              provider: "codex",
              status: "running",
              orchestrationStatus: "running",
              createdAt: "2026-04-01T09:04:00.000Z",
              updatedAt: "2026-04-01T09:04:00.000Z",
            },
          }),
        ],
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("user-1"),
        role: "user",
        text: "Hello there",
        reasoningText: undefined,
        attachments: undefined,
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T09:04:01.000Z",
        updatedAt: "2026-04-01T09:04:01.000Z",
      }),
    );

    expect(next.threads[0]?.estimatedContextTokens).toBe(
      roughTokenEstimateFromCharacters("Hello there".length),
    );
    expect(next.threads[0]?.session?.tokenUsageSource).toBe("estimated");
  });

  it("preserves hidden-context baseline when estimated token usage is updated from message traffic", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            estimatedContextTokens: 1_500,
            session: {
              provider: "codex",
              status: "running",
              orchestrationStatus: "running",
              createdAt: "2026-04-01T09:04:00.000Z",
              updatedAt: "2026-04-01T09:04:00.000Z",
              tokenUsageSource: "estimated",
            },
          }),
        ],
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("user-2"),
        role: "user",
        text: "Hello there",
        reasoningText: undefined,
        attachments: undefined,
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T09:04:02.000Z",
        updatedAt: "2026-04-01T09:04:02.000Z",
      }),
    );

    expect(next.threads[0]?.estimatedContextTokens).toBe(
      1_500 + roughTokenEstimateFromCharacters("Hello there".length),
    );
    expect(next.threads[0]?.session?.tokenUsageSource).toBe("estimated");
  });

  it("updates the mapped session state and thread error", () => {
    const turnId = TurnId.makeUnsafe("turn-2");
    const next = applyDomainEvent(
      makeState(),
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: "boom",
          estimatedContextTokens: 45_000,
          modelContextWindowTokens: 1_050_000,
          tokenUsageSource: "provider",
          updatedAt: "2026-04-01T09:06:00.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session).toEqual({
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
      createdAt: "2026-04-01T09:06:00.000Z",
      updatedAt: "2026-04-01T09:06:00.000Z",
      lastError: "boom",
      tokenUsageSource: "provider",
    });
    expect(next.threads[0]?.error).toBe("boom");
    expect(next.threads[0]?.estimatedContextTokens).toBe(45_000);
    expect(next.threads[0]?.modelContextWindowTokens).toBe(1_050_000);
    expect(next.threads[0]?.latestTurn?.turnId).toBe(turnId);
  });

  it("preserves token usage source across session updates that omit token metadata", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const afterUsage = applyDomainEvent(
      makeState(),
      makeEvent("thread.session-set", {
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          estimatedContextTokens: 45_000,
          tokenUsageSource: "provider",
          updatedAt: "2026-04-01T09:06:00.000Z",
        },
      }),
    );

    const afterStatusOnly = applyDomainEvent(
      afterUsage,
      makeEvent("thread.session-set", {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-2"),
          lastError: null,
          updatedAt: "2026-04-01T09:06:05.000Z",
        },
      }),
    );

    expect(afterStatusOnly.threads[0]?.estimatedContextTokens).toBe(45_000);
    expect(afterStatusOnly.threads[0]?.session?.tokenUsageSource).toBe("provider");
  });

  it("updates estimatedContextTokens from thread.compacted and marks them as locally estimated", () => {
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            session: {
              provider: "codex",
              status: "ready",
              orchestrationStatus: "ready",
              createdAt: "2026-04-01T09:04:00.000Z",
              updatedAt: "2026-04-01T09:04:00.000Z",
              tokenUsageSource: "provider",
            },
          }),
        ],
      }),
      makeEvent("thread.compacted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        compaction: {
          summary: "Compacted context",
          trigger: "manual",
          estimatedTokens: 1_200,
          modelContextWindowTokens: 400_000,
          createdAt: "2026-04-01T09:07:00.000Z",
          direction: null,
          pivotMessageId: null,
          fromTurnCount: 1,
          toTurnCount: 2,
        },
      }),
    );

    expect(next.threads[0]?.estimatedContextTokens).toBe(1_200);
    expect(next.threads[0]?.session?.tokenUsageSource).toBe("estimated");
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:05:00.000Z");
  });

  it("sanitizes transport-only thread.session-set errors", () => {
    const next = applyDomainEvent(
      makeState(),
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Failed to send WebSocket request.",
          updatedAt: "2026-04-01T09:06:00.000Z",
        },
      }),
    );

    expect(next.threads[0]?.session?.lastError).toBeUndefined();
    expect(next.threads[0]?.error).toBeNull();
  });

  it("upserts activities in sequence order", () => {
    const initialState = makeState({
      threads: [
        makeThread({
          activities: [
            {
              id: EventId.makeUnsafe("activity-2"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Second",
              payload: {},
              turnId: TurnId.makeUnsafe("turn-1"),
              sequence: 2,
              createdAt: "2026-04-01T09:02:00.000Z",
            },
          ],
        }),
      ],
    });

    const next = applyDomainEvent(
      initialState,
      makeEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-1"),
          tone: "tool",
          kind: "tool.started",
          summary: "First",
          payload: {},
          turnId: TurnId.makeUnsafe("turn-1"),
          sequence: 1,
          createdAt: "2026-04-01T09:01:00.000Z",
        },
      }),
    );

    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
      EventId.makeUnsafe("activity-2"),
    ]);
  });

  it("replaces thread tasks from the event payload", () => {
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            tasks: [
              {
                id: "task-1",
                content: "Old",
                activeForm: "Old",
                status: "pending",
              },
            ],
          }),
        ],
      }),
      makeEvent("thread.tasks.updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        tasks: [
          {
            id: "task-2",
            content: "Run lint",
            activeForm: "Running lint",
            status: "in_progress",
          },
        ],
        turnId: TurnId.makeUnsafe("turn-2"),
        updatedAt: "2026-04-01T09:07:00.000Z",
      }),
    );

    expect(next.threads[0]?.tasks).toEqual([
      {
        id: "task-2",
        content: "Run lint",
        activeForm: "Running lint",
        status: "in_progress",
      },
    ]);
    expect(next.threads[0]?.tasksTurnId).toBe(TurnId.makeUnsafe("turn-2"));
    expect(next.threads[0]?.tasksUpdatedAt).toBe("2026-04-01T09:07:00.000Z");
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:07:00.000Z");
  });

  it("upserts proposed plans and keeps the thread recency current", () => {
    const next = applyDomainEvent(
      makeState(),
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        proposedPlan: {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-04-01T09:03:00.000Z",
          updatedAt: "2026-04-01T09:03:30.000Z",
        },
      }),
    );

    expect(next.threads[0]?.proposedPlans).toEqual([
      {
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-04-01T09:03:00.000Z",
        updatedAt: "2026-04-01T09:03:30.000Z",
      },
    ]);
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:05:00.000Z");
  });

  it("updates project and workflow collections incrementally", () => {
    const workflow = {
      id: "workflow-1",
      projectId: ProjectId.makeUnsafe("project-2"),
      updatedAt: "2026-04-01T09:10:00.000Z",
    } as unknown as AppState["planningWorkflows"][number];
    const created = applyDomainEvent(
      makeState({ projects: [], threads: [] }),
      makeEvent("project.created", {
        projectId: ProjectId.makeUnsafe("project-2"),
        title: "New Project",
        workspaceRoot: "/tmp/new-project",
        defaultModel: "gpt-5-codex",
        scripts: [],
        createdAt: "2026-04-01T09:09:00.000Z",
        updatedAt: "2026-04-01T09:09:00.000Z",
      }),
    );
    const withWorkflow = applyDomainEvent(
      created,
      makeEvent(
        "project.workflow-upserted",
        {
          projectId: ProjectId.makeUnsafe("project-2"),
          workflow,
        },
        {
          sequence: 2,
        },
      ),
    );
    const afterDelete = applyDomainEvent(
      withWorkflow,
      makeEvent(
        "project.workflow-deleted",
        {
          projectId: ProjectId.makeUnsafe("project-2"),
          workflowId: "workflow-1" as never,
          deletedAt: "2026-04-01T09:11:00.000Z",
        },
        {
          sequence: 3,
        },
      ),
    );

    expect(created.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
    ]);
    expect(withWorkflow.planningWorkflows.map((entry) => entry.id)).toEqual(["workflow-1"]);
    expect(afterDelete.planningWorkflows).toEqual([]);
  });

  it("applies revert by pruning reverted-turn data and clearing tasks", () => {
    const turn1 = TurnId.makeUnsafe("turn-1");
    const turn2 = TurnId.makeUnsafe("turn-2");
    const initialState = makeState({
      threads: [
        makeThread({
          messages: [
            {
              id: MessageId.makeUnsafe("system-1"),
              role: "system",
              text: "System",
              createdAt: "2026-04-01T09:00:00.000Z",
              streaming: false,
            },
            {
              id: MessageId.makeUnsafe("user-1"),
              role: "user",
              text: "First",
              turnId: turn1,
              createdAt: "2026-04-01T09:01:00.000Z",
              streaming: false,
            },
            {
              id: MessageId.makeUnsafe("assistant-1"),
              role: "assistant",
              text: "Answer 1",
              turnId: turn1,
              createdAt: "2026-04-01T09:01:30.000Z",
              completedAt: "2026-04-01T09:01:40.000Z",
              streaming: false,
            },
            {
              id: MessageId.makeUnsafe("user-2"),
              role: "user",
              text: "Second",
              turnId: turn2,
              createdAt: "2026-04-01T09:02:00.000Z",
              streaming: false,
            },
            {
              id: MessageId.makeUnsafe("assistant-2"),
              role: "assistant",
              text: "Answer 2",
              turnId: turn2,
              createdAt: "2026-04-01T09:02:30.000Z",
              completedAt: "2026-04-01T09:02:40.000Z",
              streaming: false,
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: turn1,
              planMarkdown: "# Plan 1",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-04-01T09:01:10.000Z",
              updatedAt: "2026-04-01T09:01:20.000Z",
            },
            {
              id: "plan-2",
              turnId: turn2,
              planMarkdown: "# Plan 2",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-04-01T09:02:10.000Z",
              updatedAt: "2026-04-01T09:02:20.000Z",
            },
          ],
          turnDiffSummaries: [
            {
              turnId: turn1,
              completedAt: "2026-04-01T09:01:40.000Z",
              status: "ready",
              assistantMessageId: MessageId.makeUnsafe("assistant-1"),
              checkpointTurnCount: 1,
              checkpointRef: "checkpoint-1" as never,
              files: [],
            },
            {
              turnId: turn2,
              completedAt: "2026-04-01T09:02:40.000Z",
              status: "ready",
              assistantMessageId: MessageId.makeUnsafe("assistant-2"),
              checkpointTurnCount: 2,
              checkpointRef: "checkpoint-2" as never,
              files: [],
            },
          ],
          activities: [
            {
              id: EventId.makeUnsafe("activity-1"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Turn 1",
              payload: {},
              turnId: turn1,
              createdAt: "2026-04-01T09:01:35.000Z",
            },
            {
              id: EventId.makeUnsafe("activity-2"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Turn 2",
              payload: {},
              turnId: turn2,
              createdAt: "2026-04-01T09:02:35.000Z",
            },
          ],
          commandExecutions: [
            {
              id: "command-1" as Thread["commandExecutions"][number]["id"],
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: turn1,
              providerItemId: null,
              command: "pwd",
              title: null,
              status: "completed",
              detail: null,
              exitCode: 0,
              startedAt: "2026-04-01T09:01:20.000Z",
              completedAt: "2026-04-01T09:01:21.000Z",
              updatedAt: "2026-04-01T09:01:21.000Z",
              startedSequence: 1,
              lastUpdatedSequence: 2,
            },
            {
              id: "command-2" as Thread["commandExecutions"][number]["id"],
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: turn2,
              providerItemId: null,
              command: "ls",
              title: null,
              status: "completed",
              detail: null,
              exitCode: 0,
              startedAt: "2026-04-01T09:02:20.000Z",
              completedAt: "2026-04-01T09:02:21.000Z",
              updatedAt: "2026-04-01T09:02:21.000Z",
              startedSequence: 3,
              lastUpdatedSequence: 4,
            },
          ],
          tasks: [
            {
              id: "task-1",
              content: "Finish turn 2",
              activeForm: "Finishing turn 2",
              status: "in_progress",
            },
          ],
          latestTurn: {
            turnId: turn2,
            state: "completed",
            requestedAt: "2026-04-01T09:02:00.000Z",
            startedAt: "2026-04-01T09:02:00.000Z",
            completedAt: "2026-04-01T09:02:40.000Z",
            assistantMessageId: MessageId.makeUnsafe("assistant-2"),
          },
          estimatedContextTokens: 33_000,
        }),
      ],
    });

    const next = applyDomainEvent(
      initialState,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("system-1"),
      MessageId.makeUnsafe("user-1"),
      MessageId.makeUnsafe("assistant-1"),
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.commandExecutions.map((execution) => execution.id)).toEqual([
      "command-1" as Thread["commandExecutions"][number]["id"],
    ]);
    expect(next.threads[0]?.tasks).toEqual([]);
    expect(next.threads[0]?.estimatedContextTokens).toBeNull();
    expect(next.threads[0]?.latestTurn).toEqual({
      turnId: turn1,
      state: "completed",
      requestedAt: "2026-04-01T09:01:40.000Z",
      startedAt: "2026-04-01T09:01:40.000Z",
      completedAt: "2026-04-01T09:01:40.000Z",
      assistantMessageId: MessageId.makeUnsafe("assistant-1"),
    });
  });

  it("ignores stale command execution recorded events", () => {
    const commandExecutionId = "command-1" as Thread["commandExecutions"][number]["id"];
    const initialState = makeState({
      threads: [
        makeThread({
          commandExecutions: [
            {
              id: commandExecutionId,
              threadId: ThreadId.makeUnsafe("thread-1"),
              turnId: TurnId.makeUnsafe("turn-1"),
              providerItemId: null,
              command: "bun run lint",
              title: null,
              status: "completed",
              detail: null,
              exitCode: 0,
              startedAt: "2026-04-01T09:01:00.000Z",
              completedAt: "2026-04-01T09:01:05.000Z",
              updatedAt: "2026-04-01T09:01:05.000Z",
              startedSequence: 1,
              lastUpdatedSequence: 5,
            },
          ],
        }),
      ],
    });

    const next = applyDomainEvent(
      initialState,
      makeEvent(
        "thread.command-execution-recorded",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          commandExecution: {
            id: commandExecutionId,
            turnId: TurnId.makeUnsafe("turn-1"),
            providerItemId: null,
            command: "bun run lint",
            title: null,
            status: "running",
            detail: null,
            exitCode: null,
            startedAt: "2026-04-01T09:01:00.000Z",
            completedAt: null,
            updatedAt: "2026-04-01T09:01:04.000Z",
          },
        },
        {
          sequence: 4,
        },
      ),
    );

    expect(next).toBe(initialState);
  });

  it("buffers thread.message-sent while details are loading and the buffer is retained", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState({
      threads: [
        makeThread({
          detailsLoaded: false,
        }),
      ],
      detailEventBufferByThreadId: new Map([[threadId, { events: [], retainers: 1 }]]),
    });

    const next = applyDomainEvent(
      initialState,
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("assistant-1"),
        role: "assistant",
        text: "Hello",
        reasoningText: undefined,
        attachments: undefined,
        turnId,
        streaming: false,
        createdAt: "2026-04-01T09:04:01.000Z",
        updatedAt: "2026-04-01T09:04:02.000Z",
      }),
    );

    // The gated message handler leaves thread.messages untouched; the event is
    // queued in the detail buffer for replay after syncThreadDetails resolves.
    expect(next.threads[0]?.messages).toEqual([]);
    expect(next.detailEventBufferByThreadId.get(threadId)?.events).toHaveLength(1);
    expect(next.detailEventBufferByThreadId.get(threadId)?.events[0]?.type).toBe(
      "thread.message-sent",
    );
  });

  it("drops live thread.message-sent events when no detail fetch is in flight", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            detailsLoaded: false,
          }),
        ],
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("assistant-early"),
        role: "assistant",
        text: "Hello early",
        reasoningText: undefined,
        attachments: undefined,
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T09:04:01.000Z",
        updatedAt: "2026-04-01T09:04:02.000Z",
      }),
    );

    // No buffer + details not loaded → detail mutations are dropped; the next
    // detail fetch/replay will rehydrate state from the read model.
    expect(next.threads[0]?.messages).toEqual([]);
    expect(next.detailEventBufferByThreadId.size).toBe(0);
  });

  it("clears unloaded thread token usage immediately on thread.reverted", () => {
    const next = applyDomainEvent(
      makeState({
        threads: [
          makeThread({
            detailsLoaded: false,
            estimatedContextTokens: 12_345,
            session: {
              provider: "codex",
              status: "ready",
              orchestrationStatus: "ready",
              createdAt: "2026-04-01T09:04:00.000Z",
              updatedAt: "2026-04-01T09:04:00.000Z",
              tokenUsageSource: "provider",
            },
          }),
        ],
      }),
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
      }),
    );

    expect(next.threads[0]?.estimatedContextTokens).toBeNull();
    expect(next.threads[0]?.session?.tokenUsageSource).toBeUndefined();
  });

  it("drops unloaded detail mutations when no detail fetch is in flight", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState({
      threads: [
        makeThread({
          detailsLoaded: false,
          tasks: [
            {
              id: "task-stale",
              content: "Stale task",
              activeForm: "Stale task",
              status: "pending",
            },
          ],
        }),
      ],
    });

    const next = applyDomainEvent(
      initialState,
      makeEvent("thread.tasks.updated", {
        threadId,
        tasks: [
          {
            id: "task-1",
            content: "Run lint",
            activeForm: "Running lint",
            status: "in_progress",
          },
        ],
        turnId,
        updatedAt: "2026-04-01T09:07:00.000Z",
      }),
    );

    expect(next.threads[0]?.tasks).toEqual(initialState.threads[0]?.tasks);
    expect(next.threads[0]?.tasksTurnId).toBeNull();
    expect(next.threads[0]?.tasksUpdatedAt).toBeNull();
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:07:00.000Z");
    expect(next.detailEventBufferByThreadId.size).toBe(0);
  });
});
