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
import { CodeReviewWorkflowServiceLive } from "./CodeReviewWorkflowService.ts";

const NOW = "2026-04-02T12:00:00.000Z";

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
    streamDomainEvents: Stream.fromQueue(queue),
  };

  const runtime = ManagedRuntime.make(
    CodeReviewWorkflowServiceLive.pipe(
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
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
              oldestLoadedCommandExecutionCursor: null,
              detailSequence: snapshot.snapshotSequence,
            }),
          getThreadHistoryPage: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              messages: [],
              checkpoints: [],
              commandExecutions: [],
              hasOlderMessages: false,
              hasOlderCheckpoints: false,
              hasOlderCommandExecutions: false,
              oldestLoadedMessageCursor: null,
              oldestLoadedCheckpointTurnCount: null,
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

  it("starts reviewer threads in default interaction mode", async () => {
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
    expect(reviewCommands.every((command) => command.interactionMode === "default")).toBe(true);
    const reviewerTurns = reviewCommands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
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

  it("starts the event stream even when reconciliation hits a workflow failure", async () => {
    const workflow = makeWorkflow();
    let failed = false;
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: workflow.reviewerA.threadId }),
          makeThread({ id: workflow.reviewerB.threadId }),
        ],
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
