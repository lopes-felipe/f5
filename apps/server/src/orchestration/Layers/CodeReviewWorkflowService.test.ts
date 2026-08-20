import {
  CheckpointRef,
  CodeReviewWorkflowId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type CodeReviewWorkflow,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";

import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import type { ProviderTurnDelivery } from "../Services/ProviderTurnDeliveryRepository.ts";
import {
  ProviderTurnDeliveryWorker,
  type ProviderTurnDeliveryWorkerShape,
} from "../Services/ProviderTurnDeliveryWorker.ts";
import { CodeReviewWorkflowServiceLive } from "./CodeReviewWorkflowService.ts";

const NOW = "2026-04-02T12:00:00.000Z";
const ERROR_AT = "2026-04-02T12:01:00.000Z";
const AFTER_ERROR = "2026-04-02T12:02:00.000Z";

function makeThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
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

function makeCompletedThread(input: {
  threadId: ThreadId;
  suffix: string;
  requestedAt?: string;
  completedAt?: string;
  text?: string;
}): OrchestrationReadModel["threads"][number] {
  const requestedAt = input.requestedAt ?? NOW;
  const completedAt = input.completedAt ?? AFTER_ERROR;
  const turnId = TurnId.makeUnsafe(`turn-${input.suffix}`);
  const messageId = MessageId.makeUnsafe(`assistant-${input.suffix}`);
  return makeThread({
    id: input.threadId,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt,
      startedAt: requestedAt,
      completedAt,
      assistantMessageId: messageId,
    },
    session: {
      threadId: input.threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: completedAt,
    },
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: input.text ?? `${input.suffix} findings`,
        turnId,
        streaming: false,
        createdAt: completedAt,
        updatedAt: completedAt,
      },
    ],
  });
}

function makeWorkflow(overrides: Partial<CodeReviewWorkflow> = {}): CodeReviewWorkflow {
  return {
    id: CodeReviewWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Code Review",
    slug: "code-review",
    reviewPrompt: "Review this branch",
    branch: null,
    reviewerA: {
      label: "Reviewer A (codex:gpt-5-codex)",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    reviewerB: {
      label: "Reviewer B (codex:gpt-5-codex)",
      slot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      status: "pending",
      pinnedTurnId: null,
      pinnedAssistantMessageId: null,
      error: null,
      updatedAt: NOW,
    },
    consolidation: {
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

function makeReadModel(input: {
  workflow?: CodeReviewWorkflow;
  threads?: OrchestrationReadModel["threads"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
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
    codeReviewWorkflows: input.workflow ? [input.workflow] : [],
    investigationWorkflows: [],
    threads: input.threads ?? [],
  };
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

function makeProviderTurnDelivery(
  threadId: ThreadId,
  state: ProviderTurnDelivery["state"],
  overrides: Partial<ProviderTurnDelivery> = {},
): ProviderTurnDelivery {
  return {
    deliveryId: CommandId.makeUnsafe(`delivery-${threadId}`),
    threadId,
    commandId: CommandId.makeUnsafe(`delivery-command-${threadId}`),
    messageId: MessageId.makeUnsafe(`delivery-message-${threadId}`),
    state,
    providerTurnId: null,
    attempt: 1,
    preSendTurnIds: [],
    event: makeEvent("thread.turn-start-requested", {
      threadId,
      turnId: TurnId.makeUnsafe(`pending-${threadId}`),
      messageId: MessageId.makeUnsafe(`delivery-message-${threadId}`),
      requestedAt: NOW,
    } as never),
    errorCode: "transport_error",
    errorDetail: "Timed out waiting for thread/start.",
    certainty: "unknown",
    notBefore: null,
    createdAt: NOW,
    updatedAt: NOW,
    outcomeProjectedAt: null,
    ...overrides,
  };
}

function makeDeliveryWorker(
  overrides: Partial<ProviderTurnDeliveryWorkerShape> = {},
): ProviderTurnDeliveryWorkerShape {
  return {
    start: Effect.void,
    drain: Effect.void,
    outcomes: Stream.empty,
    acknowledgeOutcome: () => Effect.void,
    recheck: () => Effect.succeed(null),
    retry: ({ threadId }) => Effect.succeed(makeProviderTurnDelivery(threadId, "pending")),
    discard: (threadId) => Effect.succeed(makeProviderTurnDelivery(threadId, "abandoned")),
    ...overrides,
  };
}

function lastWorkflowUpsert(dispatched: OrchestrationCommand[]) {
  const upserts = dispatched.filter(
    (
      command,
    ): command is Extract<OrchestrationCommand, { type: "project.code-review-workflow.upsert" }> =>
      command.type === "project.code-review-workflow.upsert",
  );
  return upserts.at(-1) ?? null;
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

function applyCodeReviewWorkflowCommandToSnapshot(
  snapshot: OrchestrationReadModel,
  command: OrchestrationCommand,
): OrchestrationReadModel {
  switch (command.type) {
    case "project.code-review-workflow.create": {
      const workflow: CodeReviewWorkflow = {
        id: command.workflowId,
        projectId: command.projectId,
        title: command.title,
        slug: command.slug,
        reviewPrompt: command.reviewPrompt,
        branch: command.branch,
        reviewerA: {
          label: `Reviewer A (${command.reviewerA.provider}:${command.reviewerA.model})`,
          slot: command.reviewerA,
          threadId: command.reviewerThreadIdA,
          status: "pending",
          pinnedTurnId: null,
          pinnedAssistantMessageId: null,
          error: null,
          updatedAt: command.createdAt,
        },
        reviewerB: {
          label: `Reviewer B (${command.reviewerB.provider}:${command.reviewerB.model})`,
          slot: command.reviewerB,
          threadId: command.reviewerThreadIdB,
          status: "pending",
          pinnedTurnId: null,
          pinnedAssistantMessageId: null,
          error: null,
          updatedAt: command.createdAt,
        },
        consolidation: {
          slot: command.consolidation,
          threadId: null,
          status: "not_started",
          pinnedTurnId: null,
          pinnedAssistantMessageId: null,
          error: null,
          updatedAt: command.createdAt,
        },
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        archivedAt: null,
        deletedAt: null,
      };
      return {
        ...snapshot,
        codeReviewWorkflows: [...snapshot.codeReviewWorkflows, workflow],
        updatedAt: command.createdAt,
      };
    }

    case "project.code-review-workflow.upsert":
      return {
        ...snapshot,
        codeReviewWorkflows: snapshot.codeReviewWorkflows.some(
          (workflow) => workflow.id === command.workflow.id,
        )
          ? snapshot.codeReviewWorkflows.map((workflow) =>
              workflow.id === command.workflow.id ? command.workflow : workflow,
            )
          : [...snapshot.codeReviewWorkflows, command.workflow],
        updatedAt: command.updatedAt,
      };

    case "project.code-review-workflow.delete":
      return {
        ...snapshot,
        codeReviewWorkflows: snapshot.codeReviewWorkflows.map((workflow) =>
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

    default:
      return snapshot;
  }
}

async function createHarness(
  initialSnapshot: OrchestrationReadModel,
  options?: {
    failDispatch?: (command: OrchestrationCommand, count: number) => unknown | undefined;
    providerTurnDeliveryWorker?: ProviderTurnDeliveryWorkerShape;
  },
) {
  let snapshot = initialSnapshot;
  let projectionSnapshotsFailing = false;
  let projectionSnapshotCallCount = 0;
  const dispatched: OrchestrationCommand[] = [];
  const queue = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "disabled in CodeReviewWorkflowService test harness",
      }),
    ),
  );

  const engine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(snapshot),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        const failure = options?.failDispatch?.(command, dispatched.length);
        if (failure !== undefined) {
          throw failure;
        }
        dispatched.push(command);
        snapshot = applyCodeReviewWorkflowCommandToSnapshot(snapshot, command);
        return { sequence: dispatched.length };
      }),
    acquireMaintenanceLock: () => Scope.make("sequential"),
    streamDomainEvents: Stream.fromQueue(queue),
  };

  const serviceLayer = CodeReviewWorkflowServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () =>
          Effect.suspend(() => {
            projectionSnapshotCallCount += 1;
            return projectionSnapshotsFailing
              ? Effect.die(
                  new Error("Projection snapshot disabled by CodeReviewWorkflowService test."),
                )
              : Effect.succeed(snapshot);
          }),
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
  );
  const runtime = ManagedRuntime.make(
    options?.providerTurnDeliveryWorker
      ? serviceLayer.pipe(
          Layer.provideMerge(
            Layer.succeed(ProviderTurnDeliveryWorker, options.providerTurnDeliveryWorker),
          ),
        )
      : serviceLayer,
  );

  const service = await runtime.runPromise(Effect.service(CodeReviewWorkflowService));
  let closeStartScope: (() => Promise<void>) | null = null;

  return {
    service,
    dispatched,
    generateThreadTitle,
    getSnapshot() {
      return snapshot;
    },
    getProjectionSnapshotCallCount() {
      return projectionSnapshotCallCount;
    },
    failProjectionSnapshots() {
      projectionSnapshotsFailing = true;
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

describe("CodeReviewWorkflowService", () => {
  let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.dispose();
    }
    harness = null;
  });

  it("starts v2 reviewers with unattended read-only turns", async () => {
    harness = await createHarness(makeReadModel({}));

    await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Code Review",
        reviewPrompt: "Review the implementation",
        reviewerA: { provider: "codex", model: "gpt-5-codex" },
        reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        consolidation: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const reviewCommands = harness.dispatched.filter(
      (
        command,
      ): command is Extract<
        OrchestrationCommand,
        { type: "thread.create" | "thread.turn.start" }
      > => command.type === "thread.create" || command.type === "thread.turn.start",
    );

    expect(reviewCommands).not.toHaveLength(0);
    expect(
      reviewCommands
        .filter((command) => command.type === "thread.create")
        .every((command) => command.interactionMode === "default"),
    ).toBe(true);
    const reviewerTurns = reviewCommands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    expect(reviewerTurns.every((command) => command.interactionMode === "plan")).toBe(true);
    expect(
      reviewerTurns.every((command) => command.workflowExecutionProfile === "unattended-readonly"),
    ).toBe(true);
    expect(
      reviewerTurns.find((command) => command.provider === "claudeAgent")?.message.text,
    ).toContain("Prefer dedicated tools over shell commands");
    expect(reviewerTurns.find((command) => command.provider === "codex")?.message.text).toContain(
      "prefer `rg` and `rg --files`",
    );
    expect(reviewerTurns[0]?.message.text).toContain("file_path:line_number");
  });

  it("deletes the persisted workflow if reviewer thread creation fails", async () => {
    harness = await createHarness(makeReadModel({}), {
      failDispatch: (command) =>
        command.type === "thread.create" && command.title === "Reviewer B"
          ? new Error("thread create failed")
          : undefined,
    });

    await expect(
      Effect.runPromise(
        harness.service.createWorkflow({
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Code Review",
          reviewPrompt: "Review the implementation",
          reviewerA: { provider: "codex", model: "gpt-5-codex" },
          reviewerB: { provider: "codex", model: "gpt-5-codex" },
          consolidation: { provider: "codex", model: "gpt-5-codex" },
        }),
      ),
    ).rejects.toThrow("thread create failed");

    expect(
      harness.dispatched.some((command) => command.type === "project.code-review-workflow.delete"),
    ).toBe(true);
  });

  it("creates a fallback-titled code review workflow immediately and upserts the generated title later", async () => {
    harness = await createHarness(makeReadModel({}));
    const activeHarness = harness;
    if (!activeHarness) {
      throw new Error("Harness not initialized.");
    }
    const generatedTitle = Promise.withResolvers<{ title: string }>();
    activeHarness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => generatedTitle.promise),
    );

    const workflowId = await Effect.runPromise(
      activeHarness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        reviewPrompt: "  Review the workflow title automation.  ",
        branch: "main",
        titleGenerationModel: "custom/title-model",
        reviewerA: { provider: "codex", model: "gpt-5-codex" },
        reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        consolidation: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const createCommand = activeHarness.dispatched.find(
      (
        command,
      ): command is Extract<
        OrchestrationCommand,
        { type: "project.code-review-workflow.create" }
      > => command.type === "project.code-review-workflow.create",
    );
    expect(workflowId).toBe(createCommand?.workflowId);
    expect(createCommand?.title).toBe("Branch: main");

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    expect(activeHarness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/project",
      message: "Branch: main\n\n  Review the workflow title automation.  ",
      model: "custom/title-model",
    });
    expect(
      activeHarness.getSnapshot().codeReviewWorkflows.find((workflow) => workflow.id === workflowId)
        ?.title,
    ).toBe("Branch: main");

    generatedTitle.resolve({ title: "Review workflow title automation" });
    await activeHarness.drain();

    expect(
      activeHarness.getSnapshot().codeReviewWorkflows.find((workflow) => workflow.id === workflowId)
        ?.title,
    ).toBe("Review workflow title automation");
  });

  it("skips code review workflow title generation when a manual title is provided", async () => {
    harness = await createHarness(makeReadModel({}));

    await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Manual code review title",
        reviewPrompt: "Review the workflow title automation",
        titleGenerationModel: "custom/title-model",
        reviewerA: { provider: "codex", model: "gpt-5-codex" },
        reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        consolidation: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await harness.drain();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(
      harness.dispatched.find(
        (
          command,
        ): command is Extract<
          OrchestrationCommand,
          { type: "project.code-review-workflow.create" }
        > => command.type === "project.code-review-workflow.create",
      )?.title,
    ).toBe("Manual code review title");
  });

  it("does not upsert a generated code review title after the workflow is deleted", async () => {
    harness = await createHarness(makeReadModel({}));
    const activeHarness = harness;
    if (!activeHarness) {
      throw new Error("Harness not initialized.");
    }
    const generatedTitle = Promise.withResolvers<{ title: string }>();
    activeHarness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => generatedTitle.promise),
    );

    const workflowId = await Effect.runPromise(
      activeHarness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        reviewPrompt: "Review workflow deletion races",
        reviewerA: { provider: "codex", model: "gpt-5-codex" },
        reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        consolidation: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(activeHarness.service.deleteWorkflow(workflowId));

    generatedTitle.resolve({ title: "Should not apply" });
    await activeHarness.drain();

    const workflow = activeHarness
      .getSnapshot()
      .codeReviewWorkflows.find((entry) => entry.id === workflowId);
    expect(workflow?.deletedAt).not.toBeNull();
    expect(workflow?.title).toBe("Review workflow deletion races");
  });

  it("applies a generated title after the workflow is archived", async () => {
    harness = await createHarness(makeReadModel({}));
    const activeHarness = harness;
    if (!activeHarness) {
      throw new Error("Harness not initialized.");
    }
    const generatedTitle = Promise.withResolvers<{ title: string }>();
    activeHarness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => generatedTitle.promise),
    );

    const workflowId = await Effect.runPromise(
      activeHarness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        reviewPrompt: "Review code review workflow title archive races",
        reviewerA: { provider: "codex", model: "gpt-5-codex" },
        reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        consolidation: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(activeHarness.service.archiveWorkflow(workflowId));

    generatedTitle.resolve({ title: "Archived code review title still updates" });
    await activeHarness.drain();

    const workflow = activeHarness
      .getSnapshot()
      .codeReviewWorkflows.find((entry) => entry.id === workflowId);
    expect(workflow?.archivedAt).not.toBeNull();
    expect(workflow?.title).toBe("Archived code review title still updates");
  });

  it("archives and unarchives code review workflows without deleting them", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(makeReadModel({ workflow }));

    await Effect.runPromise(harness.service.archiveWorkflow(workflow.id));

    const archivedWorkflow = harness
      .getSnapshot()
      .codeReviewWorkflows.find((entry) => entry.id === workflow.id);
    expect(archivedWorkflow?.archivedAt).not.toBeNull();
    expect(archivedWorkflow?.deletedAt).toBeNull();

    await Effect.runPromise(harness.service.unarchiveWorkflow(workflow.id));

    const unarchivedWorkflow = harness
      .getSnapshot()
      .codeReviewWorkflows.find((entry) => entry.id === workflow.id);
    expect(unarchivedWorkflow?.archivedAt).toBeNull();
    expect(unarchivedWorkflow?.deletedAt).toBeNull();
  });

  it("rejects archiving an archived workflow and unarchiving an active workflow", async () => {
    const archivedWorkflow = makeWorkflow({ archivedAt: NOW });
    harness = await createHarness(makeReadModel({ workflow: archivedWorkflow }));

    await expect(
      Effect.runPromise(harness.service.archiveWorkflow(archivedWorkflow.id)),
    ).rejects.toThrow("already archived");

    const activeWorkflow = makeWorkflow({
      id: CodeReviewWorkflowId.makeUnsafe("workflow-2"),
    });
    harness = await createHarness(makeReadModel({ workflow: activeWorkflow }));

    await expect(
      Effect.runPromise(harness.service.unarchiveWorkflow(activeWorkflow.id)),
    ).rejects.toThrow("is not archived");
  });

  it("reconciles archived workflows on service start", async () => {
    const workflow = makeWorkflow({ archivedAt: NOW });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: workflow.reviewerA.threadId }),
          makeThread({ id: workflow.reviewerB.threadId }),
        ],
      }),
    );

    await harness.start();

    const turnStarts = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );

    expect(turnStarts).toHaveLength(2);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.reviewerA.status).toBe("running");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.archivedAt).toBe(NOW);
  });

  it("restarts pending reviewers during reconciliation", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: workflow.reviewerA.threadId }),
          makeThread({ id: workflow.reviewerB.threadId }),
        ],
      }),
    );

    await harness.start();

    const turnStarts = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    const lastUpsert = harness.dispatched
      .toReversed()
      .find(
        (
          command,
        ): command is Extract<
          OrchestrationCommand,
          { type: "project.code-review-workflow.upsert" }
        > => command.type === "project.code-review-workflow.upsert",
      );

    expect(turnStarts).toHaveLength(2);
    expect(lastUpsert?.workflow.reviewerA.status).toBe("running");
    expect(lastUpsert?.workflow.reviewerB.status).toBe("running");
  });

  it("does not complete reviewers from diff capture while the latest turn is still running", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-review-a"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-old"),
                role: "assistant",
                text: "Old reviewer finding",
                turnId: TurnId.makeUnsafe("older-turn"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-diff-completed", {
        threadId: workflow.reviewerA.threadId,
        turnId: TurnId.makeUnsafe("turn-review-a"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-review-a"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.reviewerA.status).toBe("running");
  });

  it("starts consolidation exactly once after a reviewer reaches a final ready state", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-review-a"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Reviewer A finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    const readyEvent = makeEvent("thread.session-set", {
      threadId: workflow.reviewerA.threadId,
      session: {
        threadId: workflow.reviewerA.threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });

    await harness.emit(readyEvent);

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );

    await harness.emit(readyEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const consolidationCreates = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create" && command.title === "Review Merge",
    );

    expect(consolidationCreates).toHaveLength(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("running");
  });

  it("starts consolidation when the final reviewer output is reasoning-only", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-review-a"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "",
                reasoningText: "Reasoning-only reviewer finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: {
          threadId: workflow.reviewerA.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );

    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.text.includes("Reasoning-only reviewer finding"),
      ),
    ).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("running");
  });

  it("starts consolidation from a ready reviewer session without querying the projection snapshot", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-review-a"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Reviewer A finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    const projectionSnapshotCallsBefore = harness.getProjectionSnapshotCallCount();
    harness.failProjectionSnapshots();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: {
          threadId: workflow.reviewerA.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("running");
    expect(harness.getProjectionSnapshotCallCount()).toBe(projectionSnapshotCallsBefore);
  });

  it("completes consolidation from a ready session without querying the projection snapshot", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-a"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-b"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: ThreadId.makeUnsafe("review-merge"),
        status: "running",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.consolidation.threadId!,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-merge"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.consolidation.threadId!,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-merge"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
        ],
      }),
    );
    await harness.start();

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.consolidation.threadId!,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-merge"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-merge"),
            },
            session: {
              threadId: workflow.consolidation.threadId!,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-merge"),
                role: "assistant",
                text: "Merged review findings",
                turnId: TurnId.makeUnsafe("turn-merge"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    const projectionSnapshotCallsBefore = harness.getProjectionSnapshotCallCount();
    harness.failProjectionSnapshots();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.consolidation.threadId!,
        session: {
          threadId: workflow.consolidation.threadId!,
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
      () => lastWorkflowUpsert(harness!.dispatched)?.workflow.consolidation.status === "completed",
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("completed");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.pinnedTurnId).toEqual(
      TurnId.makeUnsafe("turn-merge"),
    );
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.pinnedAssistantMessageId,
    ).toEqual(MessageId.makeUnsafe("assistant-merge"));
    expect(harness.getProjectionSnapshotCallCount()).toBe(projectionSnapshotCallsBefore);
  });

  it("reconciles finished reviewer threads on service start", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Reviewer A finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );

    const consolidationCreates = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create" && command.title === "Review Merge",
    );

    expect(consolidationCreates).toHaveLength(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("running");
  });

  it("processes reviewer completion events for archived workflows", async () => {
    const workflow = makeWorkflow({
      archivedAt: NOW,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "running",
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-review-a"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Reviewer A finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-review-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Reviewer B finding",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: {
          threadId: workflow.reviewerA.threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.consolidation.status).toBe("running");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.archivedAt).toBe(NOW);
  });

  it("allows retryWorkflow for archived workflows", async () => {
    const workflow = makeWorkflow({
      archivedAt: NOW,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer failed.",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [makeThread({ id: workflow.reviewerA.threadId })],
      }),
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "failed",
      }),
    );

    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === workflow.reviewerA.threadId,
      ),
    ).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.reviewerA.status).toBe("running");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.archivedAt).toBe(NOW);
  });

  it("preserves both reviewer reconciliation errors in the final upsert", async () => {
    const workflow = makeWorkflow({
      reviewerA: { ...makeWorkflow().reviewerA, status: "running" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "running" },
    });
    harness = await createHarness(makeReadModel({ workflow, threads: [] }));

    await harness.start();

    const lastUpsert = harness.dispatched
      .toReversed()
      .find(
        (
          command,
        ): command is Extract<
          OrchestrationCommand,
          { type: "project.code-review-workflow.upsert" }
        > => command.type === "project.code-review-workflow.upsert",
      );

    expect(lastUpsert?.workflow.reviewerA.status).toBe("error");
    expect(lastUpsert?.workflow.reviewerB.status).toBe("error");
  });

  it("heals newer reviewer completions on startup and starts consolidation exactly once", async () => {
    const workflow = makeWorkflow({
      archivedAt: ERROR_AT,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A disconnected",
        updatedAt: ERROR_AT,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "error",
        error: "Reviewer B disconnected",
        updatedAt: ERROR_AT,
      },
    });
    const reviewerAThread = makeCompletedThread({
      threadId: workflow.reviewerA.threadId,
      suffix: "review-a-late",
    });
    const reviewerBThread = makeCompletedThread({
      threadId: workflow.reviewerB.threadId,
      suffix: "review-b-late",
    });
    harness = await createHarness(
      makeReadModel({ workflow, threads: [reviewerAThread, reviewerBThread] }),
    );

    await harness.start();
    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    );
    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: reviewerAThread.session!,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const recovered = harness.getSnapshot().codeReviewWorkflows[0]!;
    expect(recovered.reviewerA).toMatchObject({
      status: "completed",
      error: null,
      pinnedTurnId: TurnId.makeUnsafe("turn-review-a-late"),
    });
    expect(recovered.reviewerB).toMatchObject({
      status: "completed",
      error: null,
      pinnedTurnId: TurnId.makeUnsafe("turn-review-b-late"),
    });
    expect(recovered.archivedAt).toBe(ERROR_AT);
    expect(
      harness.dispatched.filter(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toHaveLength(1);
  });

  it("partially heals newer evidence while preserving an error with only older evidence", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A disconnected",
        updatedAt: ERROR_AT,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "error",
        error: "Original Reviewer B failure",
        updatedAt: ERROR_AT,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeCompletedThread({
            threadId: workflow.reviewerA.threadId,
            suffix: "review-a-newer",
          }),
          makeCompletedThread({
            threadId: workflow.reviewerB.threadId,
            suffix: "review-b-older",
            completedAt: NOW,
          }),
        ],
      }),
    );

    await harness.start();

    const recovered = harness.getSnapshot().codeReviewWorkflows[0]!;
    expect(recovered.reviewerA.status).toBe("completed");
    expect(recovered.reviewerB).toMatchObject({
      status: "error",
      error: "Original Reviewer B failure",
      pinnedTurnId: null,
    });
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
  });

  it("heals a newer consolidation completion without starting another merge", async () => {
    const workflow = makeWorkflow({
      archivedAt: ERROR_AT,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-a"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-b"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: ThreadId.makeUnsafe("review-merge"),
        status: "error",
        error: "Merge connection reset",
        updatedAt: ERROR_AT,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeCompletedThread({
            threadId: workflow.consolidation.threadId!,
            suffix: "merge-late",
            text: "Merged findings",
          }),
        ],
      }),
    );

    await harness.start();

    const recovered = harness.getSnapshot().codeReviewWorkflows[0]!;
    expect(recovered.consolidation).toMatchObject({
      status: "completed",
      error: null,
      pinnedTurnId: TurnId.makeUnsafe("turn-merge-late"),
      pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-merge-late"),
    });
    expect(recovered.archivedAt).toBe(ERROR_AT);
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
  });

  it("resumes a persisted pending consolidation after startup", async () => {
    const reviewerAThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      suffix: "review-a",
    });
    const reviewerBThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      suffix: "review-b",
    });
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: reviewerAThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerAThread.latestTurn!.assistantMessageId,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: reviewerBThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerBThread.latestTurn!.assistantMessageId,
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "pending_start",
      },
    });
    harness = await createHarness(
      makeReadModel({ workflow, threads: [reviewerAThread, reviewerBThread] }),
    );

    await harness.start();

    expect(
      harness.dispatched.filter(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toHaveLength(1);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation.status).toBe("running");
  });

  it("reuses a persisted consolidation thread when resuming pending start", async () => {
    const consolidationThreadId = ThreadId.makeUnsafe("persisted-review-merge");
    const reviewerAThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      suffix: "review-a",
    });
    const reviewerBThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      suffix: "review-b",
    });
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: reviewerAThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerAThread.latestTurn!.assistantMessageId,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: reviewerBThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerBThread.latestTurn!.assistantMessageId,
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: consolidationThreadId,
        status: "pending_start",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [reviewerAThread, reviewerBThread, makeThread({ id: consolidationThreadId })],
      }),
    );

    await harness.start();

    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === consolidationThreadId,
      ),
    ).toBe(true);
  });

  it("marks a crash-window running consolidation retryable when no turn or delivery exists", async () => {
    const consolidationThreadId = ThreadId.makeUnsafe("review-merge-without-turn");
    const workflow = makeWorkflow({
      reviewerA: { ...makeWorkflow().reviewerA, status: "completed" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: consolidationThreadId,
        status: "running",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: consolidationThreadId,
            session: {
              threadId: consolidationThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
      { providerTurnDeliveryWorker: makeDeliveryWorker() },
    );

    await harness.start();

    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation).toMatchObject({
      status: "error",
      error: "Consolidation had no active or recoverable turn during reconciliation.",
    });
  });

  it("ignores stale session errors for completed reviewer and consolidation stages", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-a"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-b"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: ThreadId.makeUnsafe("review-merge"),
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-merge"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-merge"),
      },
    });
    harness = await createHarness(makeReadModel({ workflow }));
    await harness.start();

    for (const threadId of [workflow.reviewerA.threadId, workflow.consolidation.threadId!]) {
      await harness.emit(
        makeEvent("thread.session-set", {
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Late stale failure",
            updatedAt: AFTER_ERROR,
          },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const unchanged = harness.getSnapshot().codeReviewWorkflows[0]!;
    expect(unchanged.reviewerA).toMatchObject({ status: "completed", error: null });
    expect(unchanged.consolidation).toMatchObject({ status: "completed", error: null });
  });

  it("does not restart failed consolidation on a completed reviewer ready event", async () => {
    const reviewerAThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      suffix: "review-a",
    });
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: reviewerAThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerAThread.latestTurn!.assistantMessageId,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-b"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "error",
        error: "Merge prompt exceeded the provider limit.",
        updatedAt: ERROR_AT,
      },
    });
    harness = await createHarness(makeReadModel({ workflow, threads: [reviewerAThread] }));
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: reviewerAThread.session!,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation).toMatchObject({
      status: "error",
      error: "Merge prompt exceeded the provider limit.",
    });
  });

  it("consumes completed reviewer output during manual retry instead of dispatching a duplicate", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A disconnected",
        updatedAt: ERROR_AT,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-b"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeCompletedThread({
            threadId: workflow.reviewerA.threadId,
            suffix: "review-a-manual",
          }),
          makeCompletedThread({
            threadId: workflow.reviewerB.threadId,
            suffix: "review-b",
          }),
        ],
      }),
    );

    const result = await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );

    expect(result).toEqual({ status: "started" });
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === workflow.reviewerA.threadId,
      ),
    ).toBe(false);
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(true);
  });

  it("adopts a newer active reviewer turn without dispatching or rechecking delivery", async () => {
    const activeTurnId = TurnId.makeUnsafe("turn-review-a-active");
    const workflow = makeWorkflow({
      archivedAt: ERROR_AT,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A failed",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    const recheck = vi.fn<ProviderTurnDeliveryWorkerShape["recheck"]>(() => Effect.succeed(null));
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: activeTurnId,
              state: "running",
              requestedAt: AFTER_ERROR,
              startedAt: AFTER_ERROR,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerA.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId,
              lastError: null,
              updatedAt: AFTER_ERROR,
            },
          }),
        ],
      }),
      { providerTurnDeliveryWorker: makeDeliveryWorker({ recheck }) },
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );

    expect(recheck).not.toHaveBeenCalled();
    expect(harness.dispatched.some((command) => command.type === "thread.turn.start")).toBe(false);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("running");
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.archivedAt).toBe(ERROR_AT);
  });

  it("dispatches a persisted pending reviewer while preserving an active sibling", async () => {
    const reviewerBActiveTurn = TurnId.makeUnsafe("turn-review-b-active");
    const workflow = makeWorkflow({
      reviewerA: { ...makeWorkflow().reviewerA, status: "pending" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "running" },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: workflow.reviewerA.threadId }),
          makeThread({
            id: workflow.reviewerB.threadId,
            latestTurn: {
              turnId: reviewerBActiveTurn,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: workflow.reviewerB.threadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: reviewerBActiveTurn,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    const result = await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );

    expect(result).toEqual({ status: "started" });
    expect(
      harness.dispatched.filter(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === workflow.reviewerA.threadId,
      ),
    ).toHaveLength(1);
    expect(
      harness.dispatched.filter(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === workflow.reviewerB.threadId,
      ),
    ).toHaveLength(0);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("running");
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerB.status).toBe("running");
  });

  it("does not overwrite newer workflow state after a slow delivery recheck", async () => {
    const workflow = makeWorkflow({
      totalCostUsd: 1,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A failed",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    const recheckStarted = Promise.withResolvers<void>();
    const recheckResult = Promise.withResolvers<ProviderTurnDelivery | null>();
    const recheck = vi.fn<ProviderTurnDeliveryWorkerShape["recheck"]>(() =>
      Effect.promise(() => {
        recheckStarted.resolve();
        return recheckResult.promise;
      }),
    );
    harness = await createHarness(makeReadModel({ workflow }), {
      providerTurnDeliveryWorker: makeDeliveryWorker({ recheck }),
    });

    const retry = Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );
    await recheckStarted.promise;
    const completedWorkflow: CodeReviewWorkflow = {
      ...workflow,
      totalCostUsd: 4,
      reviewerA: {
        ...workflow.reviewerA,
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-a-newer"),
        pinnedAssistantMessageId: MessageId.makeUnsafe("assistant-review-a-newer"),
        error: null,
        updatedAt: AFTER_ERROR,
      },
      updatedAt: AFTER_ERROR,
    };
    harness.setSnapshot({
      ...harness.getSnapshot(),
      codeReviewWorkflows: [completedWorkflow],
      updatedAt: AFTER_ERROR,
    });
    recheckResult.resolve(makeProviderTurnDelivery(workflow.reviewerA.threadId, "pending"));

    await expect(retry).resolves.toEqual({ status: "started" });
    expect(harness.getSnapshot().codeReviewWorkflows[0]).toMatchObject({
      totalCostUsd: 4,
      reviewerA: {
        status: "completed",
        pinnedTurnId: TurnId.makeUnsafe("turn-review-a-newer"),
      },
    });
  });

  for (const deliveryState of ["pending", "sending"] as const) {
    it(`reuses a ${deliveryState} reviewer delivery without dispatching another turn`, async () => {
      const workflow = makeWorkflow({
        reviewerA: {
          ...makeWorkflow().reviewerA,
          status: "error",
          error: "Reviewer A failed",
          updatedAt: ERROR_AT,
        },
        reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
      });
      const recheck = vi.fn<ProviderTurnDeliveryWorkerShape["recheck"]>(() =>
        Effect.succeed(makeProviderTurnDelivery(workflow.reviewerA.threadId, deliveryState)),
      );
      harness = await createHarness(makeReadModel({ workflow }), {
        providerTurnDeliveryWorker: makeDeliveryWorker({ recheck }),
      });

      await Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
      );

      expect(recheck).toHaveBeenCalledWith(workflow.reviewerA.threadId);
      expect(harness.dispatched.some((command) => command.type === "thread.turn.start")).toBe(
        false,
      );
      expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("running");
    });
  }

  it("reuses a correlated accepted delivery that has not reached the projection yet", async () => {
    const oldTurnId = TurnId.makeUnsafe("turn-review-a-old");
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A failed",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    const accepted = makeProviderTurnDelivery(workflow.reviewerA.threadId, "accepted", {
      providerTurnId: TurnId.makeUnsafe("turn-review-a-accepted"),
      preSendTurnIds: [oldTurnId],
      errorCode: null,
      errorDetail: null,
      certainty: null,
    });
    const oldThread = makeCompletedThread({
      threadId: workflow.reviewerA.threadId,
      suffix: "review-a-old",
      completedAt: NOW,
    });
    harness = await createHarness(makeReadModel({ workflow, threads: [oldThread] }), {
      providerTurnDeliveryWorker: makeDeliveryWorker({
        recheck: () => Effect.succeed(accepted),
      }),
    });

    await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );

    expect(harness.dispatched.some((command) => command.type === "thread.turn.start")).toBe(false);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("running");
  });

  it("dispatches fresh work for an accepted delivery tied to the stale failed turn", async () => {
    const failedTurnId = TurnId.makeUnsafe("turn-review-a-failed");
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A failed",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    const accepted = makeProviderTurnDelivery(workflow.reviewerA.threadId, "accepted", {
      providerTurnId: failedTurnId,
      errorCode: null,
      errorDetail: null,
      certainty: null,
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: workflow.reviewerA.threadId,
            latestTurn: {
              turnId: failedTurnId,
              state: "error",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: ERROR_AT,
              assistantMessageId: null,
            },
          }),
        ],
      }),
      {
        providerTurnDeliveryWorker: makeDeliveryWorker({
          recheck: () => Effect.succeed(accepted),
        }),
      },
    );

    await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );

    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" && command.threadId === workflow.reviewerA.threadId,
      ),
    ).toBe(true);
  });

  it("requeues rejected delivery and requires confirmation for ambiguous delivery", async () => {
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Reviewer A failed",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    const retryDelivery = vi.fn<ProviderTurnDeliveryWorkerShape["retry"]>(({ threadId }) =>
      Effect.succeed(makeProviderTurnDelivery(threadId, "pending")),
    );
    const ambiguous = makeProviderTurnDelivery(workflow.reviewerA.threadId, "ambiguous");
    harness = await createHarness(makeReadModel({ workflow }), {
      providerTurnDeliveryWorker: makeDeliveryWorker({
        recheck: () => Effect.succeed(ambiguous),
        retry: retryDelivery,
      }),
    });

    const confirmation = await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
    );
    expect(confirmation).toEqual({
      status: "confirmation_required",
      threadIds: [workflow.reviewerA.threadId],
    });
    expect(retryDelivery).not.toHaveBeenCalled();
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("error");

    await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        scope: "failed",
        allowPossibleDuplicate: true,
      }),
    );
    expect(retryDelivery).toHaveBeenCalledWith({
      threadId: workflow.reviewerA.threadId,
      allowPossibleDuplicate: true,
    });
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("running");
  });

  it("requeues a rejected consolidation delivery on the existing thread", async () => {
    const consolidationThreadId = ThreadId.makeUnsafe("review-merge");
    const workflow = makeWorkflow({
      reviewerA: { ...makeWorkflow().reviewerA, status: "completed" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: consolidationThreadId,
        status: "error",
        error: "Merge failed",
        updatedAt: ERROR_AT,
      },
    });
    const retryDelivery = vi.fn<ProviderTurnDeliveryWorkerShape["retry"]>(({ threadId }) =>
      Effect.succeed(makeProviderTurnDelivery(threadId, "pending")),
    );
    harness = await createHarness(makeReadModel({ workflow }), {
      providerTurnDeliveryWorker: makeDeliveryWorker({
        recheck: () => Effect.succeed(makeProviderTurnDelivery(consolidationThreadId, "rejected")),
        retry: retryDelivery,
      }),
    });

    await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id, scope: "consolidation" }),
    );

    expect(retryDelivery).toHaveBeenCalledWith({
      threadId: consolidationThreadId,
      allowPossibleDuplicate: false,
    });
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Review Merge",
      ),
    ).toBe(false);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation).toMatchObject({
      threadId: consolidationThreadId,
      status: "running",
    });
  });

  it("re-marks consolidation as retryable when a fresh merge dispatch fails", async () => {
    const reviewerAThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-a"),
      suffix: "review-a",
    });
    const reviewerBThread = makeCompletedThread({
      threadId: ThreadId.makeUnsafe("reviewer-b"),
      suffix: "review-b",
    });
    const workflow = makeWorkflow({
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "completed",
        pinnedTurnId: reviewerAThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerAThread.latestTurn!.assistantMessageId,
      },
      reviewerB: {
        ...makeWorkflow().reviewerB,
        status: "completed",
        pinnedTurnId: reviewerBThread.latestTurn!.turnId,
        pinnedAssistantMessageId: reviewerBThread.latestTurn!.assistantMessageId,
      },
      consolidation: {
        ...makeWorkflow().consolidation,
        threadId: ThreadId.makeUnsafe("failed-merge"),
        status: "error",
        error: "Original merge failure",
        updatedAt: ERROR_AT,
      },
    });
    harness = await createHarness(
      makeReadModel({ workflow, threads: [reviewerAThread, reviewerBThread] }),
      {
        failDispatch: (command) =>
          command.type === "thread.turn.start"
            ? new Error("Merge dispatch unavailable")
            : undefined,
      },
    );

    await expect(
      Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "consolidation" }),
      ),
    ).rejects.toThrow("Merge dispatch unavailable");

    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation).toMatchObject({
      status: "error",
      error: "Merge dispatch unavailable",
    });
  });

  it("checks the budget before starting consolidation without an existing retry target", async () => {
    const workflow = makeWorkflow({
      totalCostUsd: 1,
      maxCostUsd: 1,
      reviewerA: { ...makeWorkflow().reviewerA, status: "completed" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
      consolidation: {
        ...makeWorkflow().consolidation,
        status: "not_started",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }));

    await expect(
      Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
      ),
    ).rejects.toThrow("Workflow cost limit reached");

    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" || command.type === "thread.turn.start",
      ),
    ).toBe(false);
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.consolidation).toMatchObject({
      status: "not_started",
      threadId: null,
      error: null,
    });
  });

  it("keeps failed reviewer state when budget, delivery recheck, or dispatch fails", async () => {
    const workflow = makeWorkflow({
      totalCostUsd: 1,
      maxCostUsd: 1,
      reviewerA: {
        ...makeWorkflow().reviewerA,
        status: "error",
        error: "Original reviewer failure",
        updatedAt: ERROR_AT,
      },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    harness = await createHarness(makeReadModel({ workflow }));

    await expect(
      Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
      ),
    ).rejects.toThrow("Workflow cost limit reached");
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA).toMatchObject({
      status: "error",
      error: "Original reviewer failure",
    });

    await harness.dispose();
    harness = await createHarness(makeReadModel({ workflow }), {
      providerTurnDeliveryWorker: makeDeliveryWorker({
        recheck: () => Effect.fail(new Error("Provider disconnected")),
      }),
    });
    await expect(
      Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
      ),
    ).rejects.toThrow("Could not verify provider delivery");
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA.status).toBe("error");

    await harness.dispose();
    harness = await createHarness(makeReadModel({ workflow: { ...workflow, maxCostUsd: null } }), {
      failDispatch: (command) =>
        command.type === "thread.turn.start" ? new Error("Dispatch unavailable") : undefined,
    });
    await expect(
      Effect.runPromise(
        harness.service.retryWorkflow({ workflowId: workflow.id, scope: "failed" }),
      ),
    ).rejects.toThrow("Dispatch unavailable");
    expect(harness.getSnapshot().codeReviewWorkflows[0]?.reviewerA).toMatchObject({
      status: "error",
      error: "Original reviewer failure",
    });
  });

  it("starts the event stream even when reconciliation hits a workflow failure", async () => {
    const workflow = makeWorkflow({
      reviewerA: { ...makeWorkflow().reviewerA, status: "running" },
      reviewerB: { ...makeWorkflow().reviewerB, status: "completed" },
    });
    let failed = false;
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [],
      }),
      {
        failDispatch: (command) => {
          if (!failed && command.type === "project.code-review-workflow.upsert") {
            failed = true;
            return new Error("reconcile upsert failed");
          }
          return undefined;
        },
      },
    );

    await harness.start();
    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.reviewerA.threadId,
        session: {
          threadId: workflow.reviewerA.threadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Reviewer failed after startup",
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "project.code-review-workflow.upsert" &&
          command.workflow.reviewerA.error === "Reviewer failed after startup",
      ),
    );
  });
});
