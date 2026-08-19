import {
  CommandId,
  InvestigationWorkflowId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type InvestigationWorkflow,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";

import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { InvestigationWorkflowService } from "../Services/InvestigationWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { InvestigationWorkflowServiceLive } from "./InvestigationWorkflowService.ts";

const NOW = "2026-04-12T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: PROJECT_ID,
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    archivedAt: null,
    createdAt: NOW,
    lastInteractionAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    estimatedContextTokens: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    activities: [],
    ...overrides,
    checkpoints: overrides.checkpoints ?? [],
    compaction: overrides.compaction ?? null,
    session: overrides.session ?? null,
  };
}

function makeAssistantMessage(input: {
  readonly id: string;
  readonly turnId: string;
  readonly text: string;
}): OrchestrationReadModel["threads"][number]["messages"][number] {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: "assistant",
    text: input.text,
    turnId: TurnId.makeUnsafe(input.turnId),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeReportThread(input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly turnId: string;
  readonly text: string;
}): OrchestrationReadModel["threads"][number] {
  return makeThread({
    id: input.threadId,
    latestTurn: {
      turnId: TurnId.makeUnsafe(input.turnId),
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: MessageId.makeUnsafe(input.messageId),
    },
    messages: [
      makeAssistantMessage({
        id: input.messageId,
        turnId: input.turnId,
        text: input.text,
      }),
    ],
  });
}

function makeWorkflow(overrides: Partial<InvestigationWorkflow> = {}): InvestigationWorkflow {
  return {
    id: InvestigationWorkflowId.makeUnsafe("investigation-workflow-1"),
    projectId: PROJECT_ID,
    title: "Investigation workflow",
    slug: "investigation-workflow",
    problemPrompt: "Investigate the issue",
    branch: null,
    selfReviewEnabled: false,
    investigatorA: {
      label: "Investigator A (codex:gpt-5-codex)",
      slot: { provider: "codex", model: "gpt-5-codex" },
      investigationThreadId: ThreadId.makeUnsafe("investigator-a"),
      investigationStatus: "pending",
      investigationTurnId: null,
      investigationMessageId: null,
      crossReviewThreadId: null,
      crossReviewStatus: "not_started",
      crossReviewTurnId: null,
      crossReviewMessageId: null,
      selfReviewThreadId: null,
      selfReviewStatus: "not_started",
      selfReviewTurnId: null,
      selfReviewMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    investigatorB: {
      label: "Investigator B (claudeAgent:claude-sonnet-4-6)",
      slot: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      investigationThreadId: ThreadId.makeUnsafe("investigator-b"),
      investigationStatus: "pending",
      investigationTurnId: null,
      investigationMessageId: null,
      crossReviewThreadId: null,
      crossReviewStatus: "not_started",
      crossReviewTurnId: null,
      crossReviewMessageId: null,
      selfReviewThreadId: null,
      selfReviewStatus: "not_started",
      selfReviewTurnId: null,
      selfReviewMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    synthesis: {
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: null,
      status: "not_started",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeCompletedInvestigationWorkflow(
  overrides: Partial<InvestigationWorkflow> = {},
): InvestigationWorkflow {
  const workflow = makeWorkflow(overrides);
  return {
    ...workflow,
    investigatorA: {
      ...workflow.investigatorA,
      investigationStatus: "completed",
      investigationTurnId: "turn-investigation-a",
      investigationMessageId: "message-investigation-a",
    },
    investigatorB: {
      ...workflow.investigatorB,
      investigationStatus: "completed",
      investigationTurnId: "turn-investigation-b",
      investigationMessageId: "message-investigation-b",
    },
  };
}

function makeFullyReviewedWorkflow(): InvestigationWorkflow {
  const workflow = makeCompletedInvestigationWorkflow({ selfReviewEnabled: true });
  return {
    ...workflow,
    investigatorA: {
      ...workflow.investigatorA,
      crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
      crossReviewStatus: "completed",
      crossReviewTurnId: "turn-cross-review-a",
      crossReviewMessageId: "message-cross-review-a",
      selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
      selfReviewStatus: "completed",
      selfReviewTurnId: "turn-self-review-a",
      selfReviewMessageId: "message-self-review-a",
    },
    investigatorB: {
      ...workflow.investigatorB,
      crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
      crossReviewStatus: "completed",
      crossReviewTurnId: "turn-cross-review-b",
      crossReviewMessageId: "message-cross-review-b",
      selfReviewThreadId: ThreadId.makeUnsafe("self-review-b"),
      selfReviewStatus: "completed",
      selfReviewTurnId: "turn-self-review-b",
      selfReviewMessageId: "message-self-review-b",
    },
    synthesis: {
      ...workflow.synthesis,
      threadId: ThreadId.makeUnsafe("synthesis"),
      status: "completed",
      pinnedTurnId: "turn-synthesis",
      pinnedAssistantMessageId: "message-synthesis",
    },
  };
}

function makeFullyReviewedThreads(
  workflow: InvestigationWorkflow,
): OrchestrationReadModel["threads"] {
  return [
    makeReportThread({
      threadId: workflow.investigatorA.investigationThreadId,
      messageId: "message-investigation-a",
      turnId: "turn-investigation-a",
      text: "Investigation A report",
    }),
    makeReportThread({
      threadId: workflow.investigatorB.investigationThreadId,
      messageId: "message-investigation-b",
      turnId: "turn-investigation-b",
      text: "Investigation B report",
    }),
    makeReportThread({
      threadId: ThreadId.makeUnsafe("cross-review-a"),
      messageId: "message-cross-review-a",
      turnId: "turn-cross-review-a",
      text: "Cross-review A report",
    }),
    makeReportThread({
      threadId: ThreadId.makeUnsafe("cross-review-b"),
      messageId: "message-cross-review-b",
      turnId: "turn-cross-review-b",
      text: "Cross-review B report",
    }),
    makeReportThread({
      threadId: ThreadId.makeUnsafe("self-review-a"),
      messageId: "message-self-review-a",
      turnId: "turn-self-review-a",
      text: "Own-model review A report",
    }),
    makeReportThread({
      threadId: ThreadId.makeUnsafe("self-review-b"),
      messageId: "message-self-review-b",
      turnId: "turn-self-review-b",
      text: "Own-model review B report",
    }),
    makeReportThread({
      threadId: ThreadId.makeUnsafe("synthesis"),
      messageId: "message-synthesis",
      turnId: "turn-synthesis",
      text: "Final RCA",
    }),
  ];
}

function makeReadModel(input: {
  readonly workflow?: InvestigationWorkflow;
  readonly threads?: OrchestrationReadModel["threads"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5-codex",
        scripts: [],
        memories: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: input.workflow ? [input.workflow] : [],
    threads: input.threads ?? [],
  };
}

function applyInvestigationWorkflowCommandToSnapshot(
  snapshot: OrchestrationReadModel,
  command: OrchestrationCommand,
): OrchestrationReadModel {
  switch (command.type) {
    case "project.investigation-workflow.create": {
      const workflow = makeWorkflow({
        id: command.workflowId,
        projectId: command.projectId,
        title: command.title,
        slug: command.slug,
        problemPrompt: command.problemPrompt,
        branch: command.branch,
        selfReviewEnabled: command.selfReviewEnabled,
        investigatorA: {
          ...makeWorkflow().investigatorA,
          label: `Investigator A (${command.investigatorA.provider}:${command.investigatorA.model})`,
          slot: command.investigatorA,
          investigationThreadId: command.investigationThreadIdA,
          updatedAt: command.createdAt,
        },
        investigatorB: {
          ...makeWorkflow().investigatorB,
          label: `Investigator B (${command.investigatorB.provider}:${command.investigatorB.model})`,
          slot: command.investigatorB,
          investigationThreadId: command.investigationThreadIdB,
          updatedAt: command.createdAt,
        },
        synthesis: {
          ...makeWorkflow().synthesis,
          slot: command.synthesis,
          updatedAt: command.createdAt,
        },
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
      return {
        ...snapshot,
        investigationWorkflows: [...snapshot.investigationWorkflows, workflow],
        updatedAt: command.createdAt,
      };
    }

    case "project.investigation-workflow.upsert":
      return {
        ...snapshot,
        investigationWorkflows: snapshot.investigationWorkflows.some(
          (workflow) => workflow.id === command.workflow.id,
        )
          ? snapshot.investigationWorkflows.map((workflow) =>
              workflow.id === command.workflow.id ? command.workflow : workflow,
            )
          : [...snapshot.investigationWorkflows, command.workflow],
        updatedAt: command.updatedAt,
      };

    case "project.investigation-workflow.delete":
      return {
        ...snapshot,
        investigationWorkflows: snapshot.investigationWorkflows.map((workflow) =>
          workflow.id === command.workflowId
            ? {
                ...workflow,
                deletedAt: command.createdAt,
                updatedAt: command.createdAt,
              }
            : workflow,
        ),
        updatedAt: command.createdAt,
      };

    case "thread.create":
      if (snapshot.threads.some((thread) => thread.id === command.threadId)) {
        throw new Error(`Thread '${command.threadId}' already exists.`);
      }
      return {
        ...snapshot,
        threads: [
          ...snapshot.threads,
          makeThread({
            id: command.threadId,
            projectId: command.projectId,
            title: command.title,
            model: command.model,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            branch: command.branch,
            worktreePath: command.worktreePath,
            createdAt: command.createdAt,
            lastInteractionAt: command.createdAt,
            updatedAt: command.createdAt,
          }),
        ],
        updatedAt: command.createdAt,
      };

    default:
      return snapshot;
  }
}

function threadCreateCommands(dispatched: ReadonlyArray<OrchestrationCommand>) {
  return dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
      command.type === "thread.create",
  );
}

function threadTurnStartCommands(dispatched: ReadonlyArray<OrchestrationCommand>) {
  return dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );
}

function makeEvent(
  type: OrchestrationEvent["type"],
  payload: OrchestrationEvent["payload"],
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    type,
    aggregateKind: "thread",
    aggregateId: "threadId" in payload ? payload.threadId : ThreadId.makeUnsafe("aggregate-thread"),
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`command-${type}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`command-${type}`),
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(initialSnapshot: OrchestrationReadModel) {
  let snapshot = initialSnapshot;
  const dispatched: OrchestrationCommand[] = [];
  const queue = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "disabled in InvestigationWorkflowService test harness",
      }),
    ),
  );

  const engine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(snapshot),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        snapshot = applyInvestigationWorkflowCommandToSnapshot(snapshot, command);
        return { sequence: dispatched.length };
      }),
    acquireMaintenanceLock: () => Scope.make("sequential"),
    streamDomainEvents: Stream.fromQueue(queue),
  };

  const runtime = ManagedRuntime.make(
    InvestigationWorkflowServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.succeed(snapshot),
          getBootstrapSnapshot: () => Effect.succeed(snapshot),
          getStartupSnapshot: () =>
            Effect.succeed({
              snapshot,
              threadTailDetails: null,
            }),
          getThreadTailDetails: (input) =>
            Effect.succeed({
              threadId: input.threadId,
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
              hasOlderActivities: false,
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
              oldestLoadedActivityCursor: null,
              oldestLoadedCommandExecutionCursor: null,
              detailSequence: snapshot.snapshotSequence,
            }),
          getThreadHistoryPage: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              activities: [],
              commandExecutions: [],
              hasOlderMessages: false,
              hasOlderCheckpoints: false,
              hasOlderActivities: false,
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
              oldestLoadedActivityCursor: null,
              oldestLoadedCommandExecutionCursor: null,
              detailSequence: snapshot.snapshotSequence,
            }),
          getThreadDetails: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              tasks: [],
              tasksTurnId: null,
              tasksUpdatedAt: null,
              sessionNotes: null,
              threadReferences: [],
              detailSequence: snapshot.snapshotSequence,
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateCommitMessage: () => Effect.die("unsupported"),
          generatePrContent: () => Effect.die("unsupported"),
          generateBranchName: () => Effect.die("unsupported"),
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
    ),
  );

  const service = await runtime.runPromise(Effect.service(InvestigationWorkflowService));
  let closeStartScope: (() => Promise<void>) | null = null;

  return {
    service,
    dispatched,
    getSnapshot() {
      return snapshot;
    },
    setSnapshot(nextSnapshot: OrchestrationReadModel) {
      snapshot = nextSnapshot;
    },
    async start() {
      const scope = await Effect.runPromise(Scope.make("sequential"));
      closeStartScope = () => Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.runPromise(service.start.pipe(Scope.provide(scope)));
    },
    async emit(event: OrchestrationEvent) {
      await Effect.runPromise(Queue.offer(queue, event));
    },
    async drain() {
      await runtime.runPromise(service.drain);
    },
    async dispose() {
      if (closeStartScope) {
        await closeStartScope();
      }
      await runtime.dispose();
    },
  };
}

describe("InvestigationWorkflowService", () => {
  let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.dispose();
    }
    harness = null;
  });

  it("creates both investigation threads and starts both investigation turns", async () => {
    harness = await createHarness(makeReadModel({}));

    const workflowId = await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: PROJECT_ID,
        problemPrompt: "Investigate failed deploys",
        investigatorA: { provider: "codex", model: "gpt-5-codex" },
        investigatorB: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        synthesis: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const workflow = harness
      .getSnapshot()
      .investigationWorkflows.find((entry) => entry.id === workflowId);
    expect(workflow?.investigatorA.investigationStatus).toBe("running");
    expect(workflow?.investigatorB.investigationStatus).toBe("running");
    expect(threadCreateCommands(harness.dispatched)).toHaveLength(2);
    expect(threadTurnStartCommands(harness.dispatched)).toHaveLength(2);
  });

  it("rejects identical investigator provider and model", async () => {
    harness = await createHarness(makeReadModel({}));

    await expect(
      Effect.runPromise(
        harness.service.createWorkflow({
          projectId: PROJECT_ID,
          problemPrompt: "Investigate failed deploys",
          investigatorA: { provider: "codex", model: "gpt-5-codex" },
          investigatorB: { provider: "codex", model: "gpt-5-codex" },
          synthesis: { provider: "codex", model: "gpt-5-codex" },
        }),
      ),
    ).rejects.toThrow("Investigation investigator models must be different.");
  });

  it("recreates missing initial investigation threads during reconciliation", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(makeReadModel({ workflow }));

    await harness.start();

    const investigationCreates = threadCreateCommands(harness.dispatched).filter((command) =>
      command.title.startsWith("Investigator "),
    );
    expect(investigationCreates.map((command) => command.threadId)).toEqual([
      "investigator-a",
      "investigator-b",
    ]);
    expect(threadTurnStartCommands(harness.dispatched).map((command) => command.threadId)).toEqual([
      "investigator-a",
      "investigator-b",
    ]);
    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.investigationStatus).toBe("running");
    expect(reconciled.investigatorB.investigationStatus).toBe("running");
  });

  it("maps all owned threads back to workflow labels", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
      },
      investigatorB: {
        ...makeCompletedInvestigationWorkflow().investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-b"),
      },
      synthesis: {
        ...makeCompletedInvestigationWorkflow().synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
      },
    });
    harness = await createHarness(makeReadModel({ workflow }));

    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("investigator-a"))),
    ).resolves.toMatchObject({ label: "Investigator A" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("investigator-b"))),
    ).resolves.toMatchObject({ label: "Investigator B" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("cross-review-a"))),
    ).resolves.toMatchObject({ label: "Cross-review A" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("cross-review-b"))),
    ).resolves.toMatchObject({ label: "Cross-review B" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("self-review-a"))),
    ).resolves.toMatchObject({ label: "Own-model review A" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("self-review-b"))),
    ).resolves.toMatchObject({ label: "Own-model review B" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("synthesis"))),
    ).resolves.toMatchObject({ label: "Synthesis" });
  });

  it("preserves downstream thread ownership when retrying a failed investigation", async () => {
    const baseWorkflow = makeWorkflow();
    const workflow = makeWorkflow({
      investigatorA: {
        ...baseWorkflow.investigatorA,
        investigationStatus: "error",
        investigationTurnId: "turn-failed-investigation-a",
        error: "Investigation failed.",
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
      },
      investigatorB: {
        ...baseWorkflow.investigatorB,
        investigationStatus: "completed",
        investigationTurnId: "turn-investigation-b",
        investigationMessageId: "message-investigation-b",
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
      synthesis: {
        ...baseWorkflow.synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
        status: "completed",
        pinnedTurnId: "turn-synthesis",
        pinnedAssistantMessageId: "message-synthesis",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "failed",
      }),
    );

    const retried = harness.getSnapshot().investigationWorkflows[0]!;
    expect(retried.investigatorA.investigationStatus).toBe("running");
    expect(retried.investigatorB.investigationStatus).toBe("completed");
    expect(retried.investigatorA.crossReviewThreadId).toBe("cross-review-a");
    expect(retried.investigatorB.crossReviewThreadId).toBe("cross-review-b");
    expect(retried.synthesis.threadId).toBe("synthesis");
    expect(retried.investigatorA.crossReviewStatus).toBe("not_started");
    expect(retried.investigatorB.crossReviewStatus).toBe("not_started");
    expect(retried.synthesis.status).toBe("not_started");
    expect(
      threadCreateCommands(harness.dispatched).some(
        (command) => command.threadId === "investigator-a",
      ),
    ).toBe(true);
  });

  it("preserves existing cross-review and synthesis threads when retrying failed review work", async () => {
    const completedWorkflow = makeCompletedInvestigationWorkflow();
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...completedWorkflow.investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "error",
        crossReviewTurnId: "turn-old-cross-review-a",
        crossReviewMessageId: "message-old-cross-review-a",
        error: "Cross-review failed.",
      },
      investigatorB: {
        ...completedWorkflow.investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
      synthesis: {
        ...completedWorkflow.synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
        status: "error",
        error: "Synthesis failed.",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-old-cross-review-a",
            turnId: "turn-old-cross-review-a",
            text: "Old failed cross-review A output",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("synthesis"), title: "RCA Synthesis" }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "failed",
      }),
    );

    const retried = harness.getSnapshot().investigationWorkflows[0]!;
    expect(retried.investigatorA.crossReviewThreadId).toBe("cross-review-a");
    expect(retried.investigatorA.crossReviewStatus).toBe("running");
    expect(retried.investigatorB.crossReviewStatus).toBe("completed");
    expect(retried.synthesis.threadId).toBe("synthesis");
    expect(retried.synthesis.status).toBe("not_started");
    expect(
      threadCreateCommands(harness.dispatched).filter(
        (command) => command.threadId === "cross-review-a",
      ),
    ).toHaveLength(0);
    expect(
      threadTurnStartCommands(harness.dispatched).find(
        (command) => command.threadId === "cross-review-a",
      )?.message.text,
    ).toContain("Retry Context");
  });

  it("explicitly retries cross-reviews without discarding completed own-model reviews", async () => {
    const workflow = makeFullyReviewedWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: makeFullyReviewedThreads(workflow),
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "crossReview",
      }),
    );

    const retried = harness.getSnapshot().investigationWorkflows[0]!;
    expect(retried.investigatorA.crossReviewStatus).toBe("running");
    expect(retried.investigatorB.crossReviewStatus).toBe("running");
    expect(retried.investigatorA.selfReviewStatus).toBe("completed");
    expect(retried.investigatorB.selfReviewStatus).toBe("completed");
    expect(retried.synthesis.threadId).toBe("synthesis");
    expect(retried.synthesis.status).toBe("not_started");
    expect(
      threadCreateCommands(harness.dispatched).some((command) =>
        ["cross-review-a", "cross-review-b", "synthesis"].includes(command.threadId),
      ),
    ).toBe(false);
    expect(
      threadTurnStartCommands(harness.dispatched).find(
        (command) => command.threadId === "cross-review-a",
      )?.message.text,
    ).toContain("Retry Context");
  });

  it("explicitly retries own-model reviews without discarding completed cross-reviews", async () => {
    const workflow = makeFullyReviewedWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: makeFullyReviewedThreads(workflow),
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "selfReview",
      }),
    );

    const retried = harness.getSnapshot().investigationWorkflows[0]!;
    expect(retried.investigatorA.crossReviewStatus).toBe("completed");
    expect(retried.investigatorB.crossReviewStatus).toBe("completed");
    expect(retried.investigatorA.selfReviewStatus).toBe("running");
    expect(retried.investigatorB.selfReviewStatus).toBe("running");
    expect(retried.synthesis.threadId).toBe("synthesis");
    expect(retried.synthesis.status).toBe("not_started");
    expect(
      threadCreateCommands(harness.dispatched).some((command) =>
        ["self-review-a", "self-review-b", "synthesis"].includes(command.threadId),
      ),
    ).toBe(false);
    expect(
      threadTurnStartCommands(harness.dispatched).find(
        (command) => command.threadId === "self-review-a",
      )?.message.text,
    ).toContain("Retry Context");
  });

  it("retries synthesis in its existing thread after all required reviews are complete", async () => {
    const workflow = makeFullyReviewedWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: makeFullyReviewedThreads(workflow),
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "synthesis",
      }),
    );

    const retried = harness.getSnapshot().investigationWorkflows[0]!;
    expect(retried.investigatorA.crossReviewStatus).toBe("completed");
    expect(retried.investigatorB.crossReviewStatus).toBe("completed");
    expect(retried.investigatorA.selfReviewStatus).toBe("completed");
    expect(retried.investigatorB.selfReviewStatus).toBe("completed");
    expect(retried.synthesis.threadId).toBe("synthesis");
    expect(retried.synthesis.status).toBe("running");
    expect(
      threadCreateCommands(harness.dispatched).filter(
        (command) => command.threadId === "synthesis",
      ),
    ).toHaveLength(0);
    expect(
      threadTurnStartCommands(harness.dispatched).find(
        (command) => command.threadId === "synthesis",
      )?.message.text,
    ).toContain("Retry Context");
  });

  it("reconciles completed investigations into running cross-reviews without stale snapshot errors", async () => {
    const workflow = makeCompletedInvestigationWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
        ],
      }),
    );

    await harness.start();

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.crossReviewStatus).toBe("running");
    expect(reconciled.investigatorA.error).toBeNull();
    expect(reconciled.investigatorA.crossReviewThreadId).not.toBeNull();
    expect(reconciled.investigatorB.crossReviewStatus).toBe("running");
    expect(reconciled.investigatorB.error).toBeNull();
    expect(reconciled.investigatorB.crossReviewThreadId).not.toBeNull();
  });

  it("starts own-model reviews in parallel with cross-reviews when enabled", async () => {
    const workflow = makeCompletedInvestigationWorkflow({ selfReviewEnabled: true });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
        ],
      }),
    );

    await harness.start();

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.crossReviewStatus).toBe("running");
    expect(reconciled.investigatorB.crossReviewStatus).toBe("running");
    expect(reconciled.investigatorA.selfReviewStatus).toBe("running");
    expect(reconciled.investigatorB.selfReviewStatus).toBe("running");
    expect(reconciled.investigatorA.selfReviewThreadId).not.toBeNull();
    expect(reconciled.investigatorB.selfReviewThreadId).not.toBeNull();
    expect(threadCreateCommands(harness.dispatched).map((command) => command.title)).toEqual([
      "Cross-review A",
      "Cross-review B",
      "Own-model review A",
      "Own-model review B",
    ]);
  });

  it("reuses prepared cross-review thread ids during reconciliation", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "pending_start",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("cross-review-a"), title: "Cross-review A" }),
        ],
      }),
    );

    await harness.start();

    const crossReviewACreates = threadCreateCommands(harness.dispatched).filter(
      (command) => command.threadId === "cross-review-a",
    );
    expect(crossReviewACreates).toHaveLength(0);
    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorA.crossReviewStatus).toBe(
      "running",
    );
    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorA.crossReviewThreadId).toBe(
      "cross-review-a",
    );
  });

  it("reuses prepared own-model review thread ids during reconciliation", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
        selfReviewStatus: "pending_start",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("self-review-a"), title: "Own-model review A" }),
        ],
      }),
    );

    await harness.start();

    const selfReviewACreates = threadCreateCommands(harness.dispatched).filter(
      (command) => command.threadId === "self-review-a",
    );
    expect(selfReviewACreates).toHaveLength(0);
    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorA.selfReviewStatus).toBe(
      "running",
    );
    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorA.selfReviewThreadId).toBe(
      "self-review-a",
    );
  });

  it("reuses prepared synthesis thread id during reconciliation", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
      },
      investigatorB: {
        ...makeCompletedInvestigationWorkflow().investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
      synthesis: {
        ...makeCompletedInvestigationWorkflow().synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
        status: "pending_start",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-cross-review-a",
            turnId: "turn-cross-review-a",
            text: "Cross-review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("synthesis"), title: "RCA Synthesis" }),
        ],
      }),
    );

    await harness.start();

    const synthesisCreates = threadCreateCommands(harness.dispatched).filter(
      (command) => command.threadId === "synthesis",
    );
    expect(synthesisCreates).toHaveLength(0);
    expect(harness.getSnapshot().investigationWorkflows[0]!.synthesis.status).toBe("running");
    expect(harness.getSnapshot().investigationWorkflows[0]!.synthesis.threadId).toBe("synthesis");
  });

  it("waits for own-model reviews before synthesis when enabled", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
      },
      investigatorB: {
        ...makeCompletedInvestigationWorkflow().investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-cross-review-a",
            turnId: "turn-cross-review-a",
            text: "Cross-review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
        ],
      }),
    );

    await harness.start();

    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorA.selfReviewStatus).toBe(
      "running",
    );
    expect(harness.getSnapshot().investigationWorkflows[0]!.investigatorB.selfReviewStatus).toBe(
      "running",
    );
    expect(harness.getSnapshot().investigationWorkflows[0]!.synthesis.status).toBe("not_started");
    expect(
      threadTurnStartCommands(harness.dispatched).some((command) =>
        command.message.text.includes("Produce the final merged Root Cause Analysis"),
      ),
    ).toBe(false);
  });

  it("includes own-model review reports in synthesis when enabled", async () => {
    const workflow = makeCompletedInvestigationWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...makeCompletedInvestigationWorkflow().investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-a"),
        selfReviewStatus: "completed",
        selfReviewTurnId: "turn-self-review-a",
        selfReviewMessageId: "message-self-review-a",
      },
      investigatorB: {
        ...makeCompletedInvestigationWorkflow().investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
        selfReviewThreadId: ThreadId.makeUnsafe("self-review-b"),
        selfReviewStatus: "completed",
        selfReviewTurnId: "turn-self-review-b",
        selfReviewMessageId: "message-self-review-b",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-cross-review-a",
            turnId: "turn-cross-review-a",
            text: "Cross-review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("self-review-a"),
            messageId: "message-self-review-a",
            turnId: "turn-self-review-a",
            text: "Own-model review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("self-review-b"),
            messageId: "message-self-review-b",
            turnId: "turn-self-review-b",
            text: "Own-model review B report",
          }),
        ],
      }),
    );

    await harness.start();

    const synthesisTurn = threadTurnStartCommands(harness.dispatched).find((command) =>
      command.message.text.includes("Produce the final Root Cause Analysis"),
    );
    expect(synthesisTurn?.message.text).toContain("Own-model review A report");
    expect(synthesisTurn?.message.text).toContain("Own-model review B report");
  });

  it("self-heals cross-review output sentinels once investigation reports are available", async () => {
    const completedWorkflow = makeCompletedInvestigationWorkflow();
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...completedWorkflow.investigatorA,
        crossReviewStatus: "error",
        error: "Investigator output not found for investigation cross-review.",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
        ],
      }),
    );

    await harness.start();

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.crossReviewStatus).toBe("running");
    expect(reconciled.investigatorA.error).toBeNull();
  });

  it("self-heals own-model review output sentinels once investigation reports are available", async () => {
    const completedWorkflow = makeCompletedInvestigationWorkflow();
    const workflow = makeCompletedInvestigationWorkflow({
      selfReviewEnabled: true,
      investigatorA: {
        ...completedWorkflow.investigatorA,
        selfReviewStatus: "error",
        error: "Investigator output not found for investigation own-model review.",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
        ],
      }),
    );

    await harness.start();

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.selfReviewStatus).toBe("running");
    expect(reconciled.investigatorA.error).toBeNull();
  });

  it("self-heals synthesis output sentinels and starts synthesis when reports are available", async () => {
    const completedWorkflow = makeCompletedInvestigationWorkflow();
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...completedWorkflow.investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
      },
      investigatorB: {
        ...completedWorkflow.investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
      synthesis: {
        ...completedWorkflow.synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
        status: "error",
        error: "Investigation upstream output not found for synthesis.",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-cross-review-a",
            turnId: "turn-cross-review-a",
            text: "Cross-review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("synthesis"), title: "RCA Synthesis" }),
        ],
      }),
    );

    await harness.start();

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.synthesis.status).toBe("running");
    expect(reconciled.synthesis.error).toBeNull();
    expect(reconciled.synthesis.threadId).toBe("synthesis");
  });

  it("ignores stale session errors after a review phase is already completed", async () => {
    const completedWorkflow = makeCompletedInvestigationWorkflow();
    const workflow = makeCompletedInvestigationWorkflow({
      investigatorA: {
        ...completedWorkflow.investigatorA,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-a"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-a",
        crossReviewMessageId: "message-cross-review-a",
      },
      investigatorB: {
        ...completedWorkflow.investigatorB,
        crossReviewThreadId: ThreadId.makeUnsafe("cross-review-b"),
        crossReviewStatus: "completed",
        crossReviewTurnId: "turn-cross-review-b",
        crossReviewMessageId: "message-cross-review-b",
      },
      synthesis: {
        ...completedWorkflow.synthesis,
        threadId: ThreadId.makeUnsafe("synthesis"),
        status: "running",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeReportThread({
            threadId: workflow.investigatorA.investigationThreadId,
            messageId: "message-investigation-a",
            turnId: "turn-investigation-a",
            text: "Investigation A report",
          }),
          makeReportThread({
            threadId: workflow.investigatorB.investigationThreadId,
            messageId: "message-investigation-b",
            turnId: "turn-investigation-b",
            text: "Investigation B report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-a"),
            messageId: "message-cross-review-a",
            turnId: "turn-cross-review-a",
            text: "Cross-review A report",
          }),
          makeReportThread({
            threadId: ThreadId.makeUnsafe("cross-review-b"),
            messageId: "message-cross-review-b",
            turnId: "turn-cross-review-b",
            text: "Cross-review B report",
          }),
          makeThread({ id: ThreadId.makeUnsafe("synthesis"), title: "RCA Synthesis" }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("cross-review-a"),
        session: {
          threadId: ThreadId.makeUnsafe("cross-review-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Stale cross-review session error.",
          updatedAt: NOW,
        },
      }),
    );

    const snapshotAfterStaleEvent = harness.getSnapshot();
    harness.setSnapshot({
      ...snapshotAfterStaleEvent,
      threads: snapshotAfterStaleEvent.threads.map((thread) =>
        thread.id === "synthesis"
          ? makeReportThread({
              threadId: ThreadId.makeUnsafe("synthesis"),
              messageId: "message-synthesis",
              turnId: "turn-synthesis",
              text: "Final RCA",
            })
          : thread,
      ),
    });
    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("synthesis"),
        session: {
          threadId: ThreadId.makeUnsafe("synthesis"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(
      () => harness!.getSnapshot().investigationWorkflows[0]?.synthesis.status === "completed",
    );

    const reconciled = harness.getSnapshot().investigationWorkflows[0]!;
    expect(reconciled.investigatorA.crossReviewStatus).toBe("completed");
    expect(reconciled.investigatorA.error).toBeNull();
    expect(reconciled.synthesis.status).toBe("completed");
  });
});
