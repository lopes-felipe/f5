import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadTailDetails,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  beginThreadDetailLoad,
  clearThreadDetailBuffer,
  drainBufferedThreadDetailEvents,
  invalidateThreadDetails,
  markThreadUnread,
  pruneChangedFilesExpandedForThreads,
  reorderProjects,
  setChangedFilesExpandedForThread,
  syncServerReadModel,
  syncStartupSnapshot,
  syncThreadDetails,
  syncThreadTailDetails,
  useStore,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { createEmptyThreadHistoryState } from "./lib/threadHistory";

type OrchestrationGetThreadDetailsResult = OrchestrationThreadTailDetails;

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
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    history: createEmptyThreadHistoryState(),
    proposedPlans: [],
    compaction: null,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-02-13T00:00:00.000Z",
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        createdAt: "2026-02-13T00:00:00.000Z",
        expanded: true,
        scripts: [],
        memories: [],
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [thread],
    threadsHydrated: true,
    lastAppliedSequence: 0,
    detailEventBufferByThreadId: new Map(),
    changedFilesExpandedByThreadId: {},
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    compaction: null,
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
        memories: [],
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModel: "gpt-5.3-codex",
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    memories: [],
    ...overrides,
  };
}

function makeThreadDetails(
  overrides: Partial<OrchestrationGetThreadDetailsResult> = {},
): OrchestrationGetThreadDetailsResult {
  return {
    threadId: ThreadId.makeUnsafe("thread-1"),
    messages: [],
    checkpoints: [],
    activities: [],
    commandExecutions: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    sessionNotes: null,
    threadReferences: [],
    hasOlderMessages: false,
    hasOlderCheckpoints: false,
    hasOlderCommandExecutions: false,
    oldestLoadedMessageCursor: null,
    oldestLoadedCheckpointTurnCount: null,
    oldestLoadedCommandExecutionCursor: null,
    detailSequence: 1,
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

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const state: AppState = {
      projects: [
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: "2026-02-27T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: "2026-02-27T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
        {
          id: project3,
          name: "Project 3",
          cwd: "/tmp/project-3",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: "2026-02-27T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
      ],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [],
      threadsHydrated: true,
      lastAppliedSequence: 0,
      detailEventBufferByThreadId: new Map(),
      changedFilesExpandedByThreadId: {},
    };

    const next = reorderProjects(state, project1, project3);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project3, project1]);
  });
});

describe("store read model sync", () => {
  it("falls back to the codex default for unsupported provider models without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "unsupported-provider-model",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("seeds lastVisitedAt from lastInteractionAt for newly hydrated threads", () => {
    const initialState: AppState = {
      projects: [],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [],
      threadsHydrated: false,
      lastAppliedSequence: 0,
      detailEventBufferByThreadId: new Map(),
      changedFilesExpandedByThreadId: {},
    };
    const readModel = makeReadModel(
      makeReadModelThread({
        lastInteractionAt: "2026-02-27T00:05:00.000Z",
        updatedAt: "2026-02-27T00:10:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.lastVisitedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps token usage metadata from the read model and reuses the existing thread when unchanged", () => {
    const initialThread = makeThread({
      model: "gpt-5.4",
      estimatedContextTokens: 45_000,
      modelContextWindowTokens: 1_050_000,
      createdAt: "2026-02-27T00:00:00.000Z",
      lastInteractionAt: "2026-02-27T00:00:00.000Z",
      lastVisitedAt: "2026-02-27T00:00:00.000Z",
    });
    const initialState = makeState(initialThread);
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "gpt-5.4",
        estimatedContextTokens: 45_000,
        modelContextWindowTokens: 1_050_000,
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]).toBe(initialThread);
    expect(next.threads[0]?.estimatedContextTokens).toBe(45_000);
    expect(next.threads[0]?.modelContextWindowTokens).toBe(1_050_000);
  });

  it("preserves the current project order when syncing incoming read model updates", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: "2026-02-27T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt: "2026-02-27T00:00:00.000Z",
          expanded: true,
          scripts: [],
          memories: [],
        },
      ],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [],
      threadsHydrated: true,
      lastAppliedSequence: 0,
      detailEventBufferByThreadId: new Map(),
      changedFilesExpandedByThreadId: {},
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project2, project1, project3]);
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        archivedAt: "2026-03-10T09:00:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.archivedAt).toBe("2026-03-10T09:00:00.000Z");
  });

  it("maps assistant reasoning text from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "final answer",
            reasoningText: "private chain summary",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-10T09:00:00.000Z",
            updatedAt: "2026-03-10T09:00:01.000Z",
          },
        ],
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.messages[0]?.reasoningText).toBe("private chain summary");
  });

  it("maps persisted thread tasks from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        tasks: [
          {
            id: "task-1",
            content: "Run tests",
            activeForm: "Running tests",
            status: "in_progress",
          },
        ],
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.tasks).toEqual([
      {
        id: "task-1",
        content: "Run tests",
        activeForm: "Running tests",
        status: "in_progress",
      },
    ]);
  });

  it("reuses thread object references when the incoming snapshot is unchanged", () => {
    const initialThread = makeThread({
      model: "gpt-5.3-codex",
      createdAt: "2026-02-27T00:00:00.000Z",
      lastInteractionAt: "2026-02-27T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-10T09:00:00.000Z",
        startedAt: "2026-03-10T09:00:00.000Z",
        completedAt: "2026-03-10T09:00:01.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
      session: {
        provider: "codex",
        status: "ready",
        orchestrationStatus: "ready",
        createdAt: "2026-03-10T09:00:02.000Z",
        updatedAt: "2026-03-10T09:00:02.000Z",
      },
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "final answer",
          reasoningText: "reasoning",
          createdAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          streaming: false,
          attachments: [
            {
              type: "image",
              id: "attachment-1",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 123,
              previewUrl: "/attachments/attachment-1",
            },
          ],
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-03-10T09:00:00.000Z",
          updatedAt: "2026-03-10T09:00:01.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-03-10T09:00:01.000Z",
          status: "ready",
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1" as Thread["turnDiffSummaries"][number]["checkpointRef"],
          files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-1"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", command: "bun run lint" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-03-10T09:00:00.500Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
        },
      ],
      lastVisitedAt: "2026-03-10T09:00:03.000Z",
    });
    const initialState = makeState(initialThread);
    const readModel = makeReadModel(
      makeReadModelThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-03-10T09:00:00.000Z",
          startedAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-03-10T09:00:02.000Z",
        },
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "final answer",
            reasoningText: "reasoning",
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 123,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: "2026-03-10T09:00:00.000Z",
            updatedAt: "2026-03-10T09:00:01.000Z",
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-03-10T09:00:00.000Z",
            updatedAt: "2026-03-10T09:00:01.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef:
              "checkpoint-1" as OrchestrationReadModel["threads"][number]["checkpoints"][number]["checkpointRef"],
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
            assistantMessageId: MessageId.makeUnsafe("assistant-1"),
            completedAt: "2026-03-10T09:00:01.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { itemType: "command_execution", command: "bun run lint" },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-03-10T09:00:00.500Z",
          },
        ],
        tasks: [
          {
            id: "task-1",
            content: "Run tests",
            activeForm: "Running tests",
            status: "in_progress",
          },
        ],
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]).toBe(initialThread);
    expect(next.threads[0]?.messages).toBe(initialThread.messages);
    expect(next.threads[0]?.activities).toBe(initialThread.activities);
    expect(next.threads[0]?.turnDiffSummaries).toBe(initialThread.turnDiffSummaries);
    expect(next.threads[0]?.proposedPlans).toBe(initialThread.proposedPlans);
    expect(next.threads[0]?.tasks).toBe(initialThread.tasks);
  });

  it("reuses unchanged nested collections when only one message updates", () => {
    const initialThread = makeThread({
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "old answer",
          createdAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          streaming: false,
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-1"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", command: "bun run lint" },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-03-10T09:00:00.500Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
        },
      ],
    });
    const initialState = makeState(initialThread);
    const readModel = makeReadModel(
      makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "new answer",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-10T09:00:00.000Z",
            updatedAt: "2026-03-10T09:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Ran command",
            payload: { itemType: "command_execution", command: "bun run lint" },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-03-10T09:00:00.500Z",
          },
        ],
        tasks: [
          {
            id: "task-1",
            content: "Run tests",
            activeForm: "Running tests",
            status: "in_progress",
          },
        ],
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]).not.toBe(initialThread);
    expect(next.threads[0]?.messages).not.toBe(initialThread.messages);
    expect(next.threads[0]?.activities).toBe(initialThread.activities);
    expect(next.threads[0]?.tasks).toBe(initialThread.tasks);
  });

  it("sanitizes transport-only session errors from snapshot sync", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "WebSocket connection closed.",
          updatedAt: "2026-03-10T09:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.session?.lastError).toBeUndefined();
    expect(next.threads[0]?.error).toBeNull();
  });

  it("syncStartupSnapshot clears unloaded thread details", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(
      makeThread({
        detailsLoaded: false,
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-stale"),
            role: "assistant",
            text: "stale",
            createdAt: "2026-03-10T09:00:00.000Z",
            completedAt: "2026-03-10T09:00:01.000Z",
            streaming: false,
          },
        ],
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-03-10T09:00:01.000Z",
            status: "ready",
            assistantMessageId: MessageId.makeUnsafe("assistant-stale"),
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as Thread["turnDiffSummaries"][number]["checkpointRef"],
            files: [],
          },
        ],
        tasks: [
          {
            id: "task-stale",
            content: "Stale task",
            activeForm: "Stale task",
            status: "pending",
          },
        ],
        tasksTurnId: turnId,
        tasksUpdatedAt: "2026-03-10T09:00:02.000Z",
      }),
    );

    const next = syncStartupSnapshot(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.threads[0]?.detailsLoaded).toBe(false);
    expect(next.threads[0]?.messages).toEqual([]);
    expect(next.threads[0]?.turnDiffSummaries).toEqual([]);
    expect(next.threads[0]?.tasks).toEqual([]);
    expect(next.threads[0]?.tasksTurnId).toBeNull();
    expect(next.threads[0]?.tasksUpdatedAt).toBeNull();
  });

  it("syncStartupSnapshot preserves previously loaded thread details", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const existingThread = makeThread({
      detailsLoaded: true,
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "persisted",
          createdAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          streaming: false,
        },
      ],
      turnDiffSummaries: [
        {
          turnId,
          completedAt: "2026-03-10T09:00:01.000Z",
          status: "ready",
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1" as Thread["turnDiffSummaries"][number]["checkpointRef"],
          files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
        },
      ],
      tasks: [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
        },
      ],
      tasksTurnId: turnId,
      tasksUpdatedAt: "2026-03-10T09:00:02.000Z",
      sessionNotes: {
        title: "Session",
        currentState: "Working",
        taskSpecification: "Implement lazy loading",
        filesAndFunctions: "store.ts",
        workflow: "default",
        errorsAndCorrections: "none",
        codebaseAndSystemDocumentation: "notes",
        learnings: "learned",
        keyResults: "done",
        worklog: "started",
        updatedAt: "2026-03-10T09:00:02.000Z",
        sourceLastInteractionAt: "2026-03-10T09:00:02.000Z",
      },
      threadReferences: [
        {
          threadId: ThreadId.makeUnsafe("thread-related"),
          relation: "research",
          createdAt: "2026-03-10T09:00:03.000Z",
        },
      ],
    });
    const initialState = makeState(existingThread);

    const next = syncStartupSnapshot(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages).toBe(existingThread.messages);
    expect(next.threads[0]?.turnDiffSummaries).toBe(existingThread.turnDiffSummaries);
    expect(next.threads[0]?.tasks).toBe(existingThread.tasks);
    expect(next.threads[0]?.sessionNotes).toBe(existingThread.sessionNotes);
    expect(next.threads[0]?.threadReferences).toBe(existingThread.threadReferences);
  });

  it("syncStartupSnapshot ignores stale snapshots that would drop newer activities", () => {
    const existingActivity = {
      id: EventId.makeUnsafe("activity-file-change"),
      createdAt: "2026-03-10T09:00:03.000Z",
      kind: "tool.completed" as const,
      summary: "File change",
      tone: "tool" as const,
      turnId: TurnId.makeUnsafe("turn-1"),
      sequence: 10,
      payload: {
        itemType: "file_change",
        changedFiles: ["inline-diff-demo.txt"],
      },
    };
    const initialState = {
      ...makeState(
        makeThread({
          activities: [existingActivity],
          lastInteractionAt: "2026-03-10T09:00:03.000Z",
        }),
      ),
      lastAppliedSequence: 10,
    } satisfies AppState;

    const staleSnapshot = {
      ...makeReadModel(
        makeReadModelThread({
          activities: [],
          lastInteractionAt: "2026-03-10T09:00:01.000Z",
        }),
      ),
      snapshotSequence: 7,
    } satisfies OrchestrationReadModel;

    const next = syncStartupSnapshot(initialState, staleSnapshot);

    expect(next).toBe(initialState);
    expect(next.threads[0]?.activities).toBe(initialState.threads[0]?.activities);
    expect(next.lastAppliedSequence).toBe(10);
  });

  it("invalidateThreadDetails clears loaded non-visible thread details and preserves the active thread", () => {
    const visibleThreadId = ThreadId.makeUnsafe("thread-visible");
    const staleThreadId = ThreadId.makeUnsafe("thread-stale");
    const visibleThread = makeThread({
      id: visibleThreadId,
      detailsLoaded: true,
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-visible"),
          role: "assistant",
          text: "visible",
          createdAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          streaming: false,
        },
      ],
    });
    const staleThread = makeThread({
      id: staleThreadId,
      detailsLoaded: true,
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-stale"),
          role: "assistant",
          text: "stale",
          createdAt: "2026-03-10T09:00:00.000Z",
          completedAt: "2026-03-10T09:00:01.000Z",
          streaming: false,
        },
      ],
      tasks: [
        {
          id: "task-stale",
          content: "Stale task",
          activeForm: "Stale task",
          status: "pending",
        },
      ],
    });
    const initialState = {
      ...makeState(visibleThread),
      threads: [visibleThread, staleThread],
      detailEventBufferByThreadId: new Map([[staleThreadId, { events: [], retainers: 1 }]]),
    } satisfies AppState;

    const next = invalidateThreadDetails(initialState, {
      preserveThreadIds: [visibleThreadId],
    });

    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages).toBe(visibleThread.messages);
    expect(next.threads[1]?.detailsLoaded).toBe(false);
    expect(next.threads[1]?.messages).toEqual([]);
    expect(next.threads[1]?.tasks).toEqual([]);
    expect(next.detailEventBufferByThreadId.size).toBe(0);
  });

  it("syncThreadDetails merges thread detail fields and advances the detail watermark", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(
      makeThread({
        detailsLoaded: false,
        messages: [],
        turnDiffSummaries: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        sessionNotes: null,
        threadReferences: [],
      }),
    );
    const details = makeThreadDetails({
      messages: [
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "loaded",
          turnId,
          streaming: false,
          createdAt: "2026-03-10T09:00:00.000Z",
          updatedAt: "2026-03-10T09:00:01.000Z",
        },
      ],
      checkpoints: [
        {
          turnId,
          checkpointTurnCount: 1,
          checkpointRef:
            "checkpoint-1" as OrchestrationGetThreadDetailsResult["checkpoints"][number]["checkpointRef"],
          status: "ready",
          files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
          assistantMessageId: MessageId.makeUnsafe("assistant-1"),
          completedAt: "2026-03-10T09:00:01.000Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "in_progress",
        },
      ],
      tasksTurnId: turnId,
      tasksUpdatedAt: "2026-03-10T09:00:02.000Z",
      sessionNotes: {
        title: "Session",
        currentState: "Working",
        taskSpecification: "Implement lazy loading",
        filesAndFunctions: "store.ts",
        workflow: "default",
        errorsAndCorrections: "none",
        codebaseAndSystemDocumentation: "notes",
        learnings: "learned",
        keyResults: "done",
        worklog: "started",
        updatedAt: "2026-03-10T09:00:02.000Z",
        sourceLastInteractionAt: "2026-03-10T09:00:02.000Z",
      },
      threadReferences: [
        {
          threadId: ThreadId.makeUnsafe("thread-related"),
          relation: "research",
          createdAt: "2026-03-10T09:00:03.000Z",
        },
      ],
      detailSequence: 9,
    });

    const next = syncThreadDetails(initialState, ThreadId.makeUnsafe("thread-1"), details);

    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages[0]?.text).toBe("loaded");
    expect(next.threads[0]?.turnDiffSummaries[0]?.checkpointTurnCount).toBe(1);
    expect(next.threads[0]?.tasks).toEqual(details.tasks);
    expect(next.threads[0]?.tasksTurnId).toBe(turnId);
    expect(next.threads[0]?.sessionNotes).toEqual(details.sessionNotes);
    expect(next.threads[0]?.threadReferences).toEqual(details.threadReferences);
    expect(next.lastAppliedSequence).toBe(9);
  });

  it("syncThreadTailDetails can preserve the global sequence cursor for partial warms", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = {
      ...makeState(
        makeThread({
          id: threadId,
          detailsLoaded: false,
          messages: [],
          turnDiffSummaries: [],
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
        }),
      ),
      lastAppliedSequence: 10,
      detailEventBufferByThreadId: new Map([
        [
          threadId,
          {
            retainers: 1,
            events: [],
          },
        ],
      ]),
    } satisfies AppState;

    const next = syncThreadTailDetails(
      initialState,
      threadId,
      makeThreadDetails({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-partial"),
            role: "assistant",
            text: "partial warm",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T09:03:00.000Z",
            updatedAt: "2026-04-01T09:03:01.000Z",
          },
        ],
        detailSequence: 20,
      }),
      { advanceLastAppliedSequence: false },
    );

    expect(next.lastAppliedSequence).toBe(10);
    expect(next.detailEventBufferByThreadId.has(threadId)).toBe(false);
    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages[0]?.text).toBe("partial warm");
  });

  it("drainBufferedThreadDetailEvents discards stale events and applies newer ones in order", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: true,
          messages: [],
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
        }),
      ),
      detailEventBufferByThreadId: new Map([
        [
          threadId,
          {
            retainers: 1,
            events: [
              makeEvent(
                "thread.message-sent",
                {
                  threadId,
                  messageId: MessageId.makeUnsafe("assistant-stale"),
                  role: "assistant",
                  text: "stale",
                  reasoningText: undefined,
                  attachments: undefined,
                  turnId,
                  streaming: false,
                  createdAt: "2026-04-01T09:04:01.000Z",
                  updatedAt: "2026-04-01T09:04:01.000Z",
                },
                { sequence: 5 },
              ),
              makeEvent(
                "thread.message-sent",
                {
                  threadId,
                  messageId: MessageId.makeUnsafe("assistant-fresh"),
                  role: "assistant",
                  text: "fresh",
                  reasoningText: undefined,
                  attachments: undefined,
                  turnId,
                  streaming: false,
                  createdAt: "2026-04-01T09:04:02.000Z",
                  updatedAt: "2026-04-01T09:04:03.000Z",
                },
                { sequence: 6, occurredAt: "2026-04-01T09:05:06.000Z" },
              ),
            ],
          },
        ],
      ]),
    } satisfies AppState;

    const next = drainBufferedThreadDetailEvents(initialState, threadId, 5);

    expect(next.detailEventBufferByThreadId.has(threadId)).toBe(false);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("assistant-fresh"),
    ]);
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:05:06.000Z");
  });

  it("syncThreadDetails ignores stale detail payloads once a newer watermark was applied", () => {
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: true,
          messages: [
            {
              id: MessageId.makeUnsafe("assistant-current"),
              role: "assistant",
              text: "current",
              createdAt: "2026-04-01T09:04:00.000Z",
              completedAt: "2026-04-01T09:04:01.000Z",
              streaming: false,
            },
          ],
        }),
      ),
      lastAppliedSequence: 10,
    } satisfies AppState;

    const next = syncThreadDetails(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
      makeThreadDetails({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-stale"),
            role: "assistant",
            text: "stale",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T09:03:00.000Z",
            updatedAt: "2026-04-01T09:03:01.000Z",
          },
        ],
        detailSequence: 9,
      }),
    );

    expect(next).toEqual(initialState);
  });

  it("syncThreadDetails ignores stale tail payloads for an unloaded thread without a detail buffer", () => {
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: false,
          messages: [],
          turnDiffSummaries: [],
          tasks: [],
          tasksTurnId: null,
          tasksUpdatedAt: null,
        }),
      ),
      lastAppliedSequence: 10,
    } satisfies AppState;

    const next = syncThreadDetails(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
      makeThreadDetails({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-stale-hidden"),
            role: "assistant",
            text: "stale hidden preload",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T09:03:00.000Z",
            updatedAt: "2026-04-01T09:03:01.000Z",
          },
        ],
        detailSequence: 9,
      }),
    );

    expect(next).toEqual(initialState);
  });

  it("syncThreadDetails preserves already-backfilled history when a fresh tail sync arrives", () => {
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: true,
          messages: [
            {
              id: MessageId.makeUnsafe("assistant-older"),
              role: "assistant",
              text: "older",
              createdAt: "2026-04-01T09:02:00.000Z",
              completedAt: "2026-04-01T09:02:01.000Z",
              streaming: false,
            },
            {
              id: MessageId.makeUnsafe("assistant-tail"),
              role: "assistant",
              text: "tail",
              createdAt: "2026-04-01T09:04:00.000Z",
              completedAt: "2026-04-01T09:04:01.000Z",
              streaming: false,
            },
          ],
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-older"),
              completedAt: "2026-04-01T09:02:01.000Z",
              status: "ready",
              assistantMessageId: MessageId.makeUnsafe("assistant-older"),
              checkpointTurnCount: 1,
              checkpointRef:
                "checkpoint-older" as Thread["turnDiffSummaries"][number]["checkpointRef"],
              files: [],
            },
            {
              turnId: TurnId.makeUnsafe("turn-tail"),
              completedAt: "2026-04-01T09:04:01.000Z",
              status: "ready",
              assistantMessageId: MessageId.makeUnsafe("assistant-tail"),
              checkpointTurnCount: 2,
              checkpointRef:
                "checkpoint-tail" as Thread["turnDiffSummaries"][number]["checkpointRef"],
              files: [],
            },
          ],
          history: {
            stage: "complete",
            hasOlderMessages: false,
            hasOlderCheckpoints: false,
            hasOlderCommandExecutions: false,
            oldestLoadedMessageCursor: {
              createdAt: "2026-04-01T09:02:00.000Z",
              messageId: MessageId.makeUnsafe("assistant-older"),
            },
            oldestLoadedCheckpointTurnCount: 1,
            oldestLoadedCommandExecutionCursor: null,
            generation: 1,
          },
        }),
      ),
      lastAppliedSequence: 10,
    } satisfies AppState;

    const next = syncThreadDetails(
      initialState,
      ThreadId.makeUnsafe("thread-1"),
      makeThreadDetails({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-tail"),
            role: "assistant",
            text: "tail",
            turnId: TurnId.makeUnsafe("turn-tail"),
            streaming: false,
            createdAt: "2026-04-01T09:04:00.000Z",
            updatedAt: "2026-04-01T09:04:01.000Z",
          },
        ],
        checkpoints: [
          {
            turnId: TurnId.makeUnsafe("turn-tail"),
            checkpointTurnCount: 2,
            checkpointRef:
              "checkpoint-tail" as OrchestrationGetThreadDetailsResult["checkpoints"][number]["checkpointRef"],
            status: "ready",
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-tail"),
            completedAt: "2026-04-01T09:04:01.000Z",
          },
        ],
        hasOlderMessages: true,
        hasOlderCheckpoints: true,
        hasOlderCommandExecutions: false,
        oldestLoadedMessageCursor: {
          createdAt: "2026-04-01T09:04:00.000Z",
          messageId: MessageId.makeUnsafe("assistant-tail"),
        },
        oldestLoadedCheckpointTurnCount: 2,
        oldestLoadedCommandExecutionCursor: null,
        detailSequence: 12,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("assistant-older"),
      MessageId.makeUnsafe("assistant-tail"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-older"),
      TurnId.makeUnsafe("turn-tail"),
    ]);
    expect(next.threads[0]?.history).toMatchObject({
      stage: "complete",
      hasOlderMessages: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
      oldestLoadedMessageCursor: {
        createdAt: "2026-04-01T09:02:00.000Z",
        messageId: MessageId.makeUnsafe("assistant-older"),
      },
      oldestLoadedCheckpointTurnCount: 1,
      oldestLoadedCommandExecutionCursor: null,
      generation: 2,
    });
    expect(next.lastAppliedSequence).toBe(12);
  });

  it("beginThreadDetailLoad retains an existing buffer until all owners release it", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: false,
        }),
      ),
    } satisfies AppState;

    const first = beginThreadDetailLoad(initialState, threadId);
    expect(first.detailEventBufferByThreadId.get(threadId)?.retainers).toBe(1);
    expect(first.detailEventBufferByThreadId.get(threadId)?.events).toEqual([]);

    const second = beginThreadDetailLoad(first, threadId);
    expect(second.detailEventBufferByThreadId.get(threadId)?.retainers).toBe(2);

    const afterOneClear = clearThreadDetailBuffer(second, threadId);
    expect(afterOneClear.detailEventBufferByThreadId.get(threadId)?.retainers).toBe(1);

    const afterSecondClear = clearThreadDetailBuffer(afterOneClear, threadId);
    expect(afterSecondClear.detailEventBufferByThreadId.has(threadId)).toBe(false);
  });

  it("syncThreadDetails replays buffered live events in the same transition", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = {
      ...makeState(
        makeThread({
          detailsLoaded: false,
          messages: [],
        }),
      ),
      detailEventBufferByThreadId: new Map([
        [
          threadId,
          {
            retainers: 1,
            events: [
              makeEvent(
                "thread.message-sent",
                {
                  threadId,
                  messageId: MessageId.makeUnsafe("assistant-live"),
                  role: "assistant",
                  text: "live",
                  reasoningText: undefined,
                  attachments: undefined,
                  turnId,
                  streaming: false,
                  createdAt: "2026-04-01T09:04:02.000Z",
                  updatedAt: "2026-04-01T09:04:03.000Z",
                },
                { sequence: 10, occurredAt: "2026-04-01T09:05:10.000Z" },
              ),
            ],
          },
        ],
      ]),
      lastAppliedSequence: 10,
    } satisfies AppState;

    const next = syncThreadDetails(
      initialState,
      threadId,
      makeThreadDetails({
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-loaded"),
            role: "assistant",
            text: "loaded",
            turnId,
            streaming: false,
            createdAt: "2026-04-01T09:04:00.000Z",
            updatedAt: "2026-04-01T09:04:01.000Z",
          },
        ],
        detailSequence: 9,
      }),
    );

    expect(next.detailEventBufferByThreadId.has(threadId)).toBe(false);
    expect(next.threads[0]?.detailsLoaded).toBe(true);
    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      MessageId.makeUnsafe("assistant-loaded"),
      MessageId.makeUnsafe("assistant-live"),
    ]);
    expect(next.threads[0]?.lastInteractionAt).toBe("2026-04-01T09:05:10.000Z");
  });

  it("drainBufferedThreadDetailEvents clears the buffer even when the thread was deleted", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = {
      projects: makeState(makeThread()).projects,
      planningWorkflows: [],
      codeReviewWorkflows: [],
      threads: [],
      threadsHydrated: true,
      lastAppliedSequence: 0,
      changedFilesExpandedByThreadId: {},
      detailEventBufferByThreadId: new Map([
        [
          threadId,
          {
            retainers: 1,
            events: [
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
                turnId: TurnId.makeUnsafe("turn-1"),
                updatedAt: "2026-04-01T09:07:00.000Z",
              }),
            ],
          },
        ],
      ]),
    } satisfies AppState;

    const next = drainBufferedThreadDetailEvents(initialState, threadId, 0);

    expect(next.threads).toEqual([]);
    expect(next.detailEventBufferByThreadId.has(threadId)).toBe(false);
  });
});

describe("changed-files expansion state", () => {
  it("defaults to expanded when no entry is present", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(makeThread({ id: threadId }));
    expect(state.changedFilesExpandedByThreadId[threadId]).toBeUndefined();
  });

  it("setChangedFilesExpandedForThread records an explicit collapse", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(makeThread({ id: threadId }));
    const next = setChangedFilesExpandedForThread(state, threadId, false);
    expect(next.changedFilesExpandedByThreadId[threadId]).toBe(false);
  });

  it("setChangedFilesExpandedForThread removes the key when re-expanding", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state: AppState = {
      ...makeState(makeThread({ id: threadId })),
      changedFilesExpandedByThreadId: { [threadId]: false },
    };
    const next = setChangedFilesExpandedForThread(state, threadId, true);
    expect(next.changedFilesExpandedByThreadId[threadId]).toBeUndefined();
    expect(Object.keys(next.changedFilesExpandedByThreadId)).toHaveLength(0);
  });

  it("setChangedFilesExpandedForThread is a no-op when value matches current", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(makeThread({ id: threadId }));
    const next = setChangedFilesExpandedForThread(state, threadId, true);
    expect(next).toBe(state);
  });

  it("pruneChangedFilesExpandedForThreads drops entries for inactive thread ids", () => {
    const active = ThreadId.makeUnsafe("thread-active");
    const stale = ThreadId.makeUnsafe("thread-stale");
    const state: AppState = {
      ...makeState(makeThread({ id: active })),
      changedFilesExpandedByThreadId: {
        [active]: false,
        [stale]: false,
      },
    };
    const next = pruneChangedFilesExpandedForThreads(state, [active]);
    expect(next.changedFilesExpandedByThreadId[active]).toBe(false);
    expect(next.changedFilesExpandedByThreadId[stale]).toBeUndefined();
  });

  it("pruneChangedFilesExpandedForThreads is a no-op when all entries are active", () => {
    const active = ThreadId.makeUnsafe("thread-active");
    const state: AppState = {
      ...makeState(makeThread({ id: active })),
      changedFilesExpandedByThreadId: { [active]: false },
    };
    const next = pruneChangedFilesExpandedForThreads(state, [active]);
    expect(next).toBe(state);
  });
});

describe("useStore.applyDomainEventBatch", () => {
  function makeMessageSentEvent(options: {
    sequence: number;
    threadId: ThreadId;
    messageId: MessageId;
    turnId: TurnId;
    text: string;
    streaming: boolean;
    createdAt?: string;
    updatedAt?: string;
  }): OrchestrationEvent {
    const occurredAt = options.updatedAt ?? "2026-04-01T09:04:02.000Z";
    return {
      sequence: options.sequence,
      eventId: EventId.makeUnsafe(`event-msg-${options.sequence}`),
      aggregateKind: "thread",
      aggregateId: options.threadId,
      occurredAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.message-sent",
      payload: {
        threadId: options.threadId,
        messageId: options.messageId,
        role: "assistant",
        text: options.text,
        attachments: undefined,
        turnId: options.turnId,
        streaming: options.streaming,
        createdAt: options.createdAt ?? "2026-04-01T09:04:01.000Z",
        updatedAt: occurredAt,
      },
    } as OrchestrationEvent;
  }

  function seedStoreForBatchTest(threadId: ThreadId, turnId: TurnId) {
    const thread = makeThread({
      id: threadId,
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-04-01T09:04:00.000Z",
        updatedAt: "2026-04-01T09:04:00.000Z",
      },
    });
    useStore.setState(makeState(thread));
  }

  it("applies a streaming burst followed by completion in a single commit", () => {
    const threadId = ThreadId.makeUnsafe("thread-batch-1");
    const turnId = TurnId.makeUnsafe("turn-batch-1");
    const messageId = MessageId.makeUnsafe("assistant-batch-1");
    seedStoreForBatchTest(threadId, turnId);

    let commitCount = 0;
    const unsubscribe = useStore.subscribe(() => {
      commitCount += 1;
    });

    const events: OrchestrationEvent[] = [
      makeMessageSentEvent({
        sequence: 1,
        threadId,
        messageId,
        turnId,
        text: "Hel",
        streaming: true,
      }),
      makeMessageSentEvent({
        sequence: 2,
        threadId,
        messageId,
        turnId,
        text: "lo",
        streaming: true,
      }),
      makeMessageSentEvent({
        sequence: 3,
        threadId,
        messageId,
        turnId,
        text: "Hello world",
        streaming: false,
        updatedAt: "2026-04-01T09:04:05.000Z",
      }),
    ];

    useStore.getState().applyDomainEventBatch(events);
    unsubscribe();

    // One notification for the whole batch — this is the core guarantee.
    expect(commitCount).toBe(1);

    const state = useStore.getState();
    expect(state.lastAppliedSequence).toBe(3);
    const thread = state.threads.find((t) => t.id === threadId);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.text).toBe("Hello world");
    expect(thread?.messages[0]?.streaming).toBe(false);
  });

  it("advances lastAppliedSequence to the last event's sequence and matches the per-event path", () => {
    const threadId = ThreadId.makeUnsafe("thread-batch-2");
    const turnId = TurnId.makeUnsafe("turn-batch-2");
    const messageId = MessageId.makeUnsafe("assistant-batch-2");

    const events: OrchestrationEvent[] = [
      makeMessageSentEvent({
        sequence: 10,
        threadId,
        messageId,
        turnId,
        text: "A",
        streaming: true,
      }),
      makeMessageSentEvent({
        sequence: 11,
        threadId,
        messageId,
        turnId,
        text: "B",
        streaming: true,
      }),
      makeMessageSentEvent({
        sequence: 12,
        threadId,
        messageId,
        turnId,
        text: "ABC",
        streaming: false,
        updatedAt: "2026-04-01T09:04:10.000Z",
      }),
    ];

    // Apply via batch.
    seedStoreForBatchTest(threadId, turnId);
    useStore.getState().applyDomainEventBatch(events);
    const batchedState = useStore.getState();
    const batchedThread = batchedState.threads.find((t) => t.id === threadId);

    // Apply via per-event path.
    seedStoreForBatchTest(threadId, turnId);
    for (const event of events) {
      useStore.getState().applyDomainEvent(event);
    }
    const perEventState = useStore.getState();
    const perEventThread = perEventState.threads.find((t) => t.id === threadId);

    expect(batchedState.lastAppliedSequence).toBe(12);
    expect(batchedState.lastAppliedSequence).toBe(perEventState.lastAppliedSequence);
    expect(batchedThread?.messages).toEqual(perEventThread?.messages);
  });

  it("is a no-op for an empty batch", () => {
    const threadId = ThreadId.makeUnsafe("thread-batch-3");
    const turnId = TurnId.makeUnsafe("turn-batch-3");
    seedStoreForBatchTest(threadId, turnId);
    const before = useStore.getState();
    useStore.getState().applyDomainEventBatch([]);
    const after = useStore.getState();
    expect(after).toBe(before);
  });
});
