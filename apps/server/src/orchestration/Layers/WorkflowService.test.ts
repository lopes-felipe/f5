import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type PlanningWorkflow,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";

import { TextGenerationError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkflowService } from "../Services/WorkflowService.ts";
import { WorkflowServiceLive } from "./WorkflowService.ts";

const NOW = "2026-03-26T12:00:00.000Z";

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

function makeWorkflow(overrides: Partial<PlanningWorkflow> = {}): PlanningWorkflow {
  return {
    id: PlanningWorkflowId.makeUnsafe("workflow-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Workflow",
    slug: "workflow",
    requirementPrompt: "Implement the plan",
    plansDirectory: "plans",
    selfReviewEnabled: true,
    branchA: {
      branchId: "a",
      authorSlot: { provider: "codex", model: "gpt-5-codex" },
      authorThreadId: ThreadId.makeUnsafe("author-a"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "revised",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    branchB: {
      branchId: "b",
      authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      authorThreadId: ThreadId.makeUnsafe("author-b"),
      planFilePath: null,
      planTurnId: null,
      revisionTurnId: null,
      reviews: [],
      status: "revised",
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    },
    merge: {
      mergeSlot: { provider: "codex", model: "gpt-5-codex" },
      threadId: ThreadId.makeUnsafe("merge-thread"),
      outputFilePath: "plans/workflow-merged.md",
      turnId: "merge-turn",
      approvedPlanId: "approved-plan",
      status: "manual_review",
      error: null,
      updatedAt: NOW,
    },
    implementation: null,
    totalCostUsd: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(input: {
  workflow?: PlanningWorkflow;
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
    planningWorkflows: input.workflow ? [input.workflow] : [],
    codeReviewWorkflows: [],
    threads: input.threads ?? [],
  };
}

function makeEvent(
  type: OrchestrationEvent["type"],
  payload: OrchestrationEvent["payload"],
  occurredAt = NOW,
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    type,
    aggregateKind: "thread",
    aggregateId: "threadId" in payload ? payload.threadId : ThreadId.makeUnsafe("aggregate-thread"),
    occurredAt,
    commandId: CommandId.makeUnsafe(`command-${type}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`command-${type}`),
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

function lastWorkflowUpsert(dispatched: OrchestrationCommand[]) {
  const upserts = dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "project.workflow.upsert" }> =>
      command.type === "project.workflow.upsert",
  );
  return upserts.at(-1) ?? null;
}

function turnStartsForThread(dispatched: OrchestrationCommand[], threadId: ThreadId) {
  return dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start" && command.threadId === threadId,
  );
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

function applyWorkflowCommandToSnapshot(
  snapshot: OrchestrationReadModel,
  command: OrchestrationCommand,
): OrchestrationReadModel {
  switch (command.type) {
    case "thread.create":
      return {
        ...snapshot,
        threads: snapshot.threads.some((thread) => thread.id === command.threadId)
          ? snapshot.threads.map((thread) =>
              thread.id === command.threadId
                ? makeThread({
                    ...thread,
                    id: command.threadId,
                    projectId: command.projectId,
                    title: command.title,
                    model: command.model,
                    runtimeMode: command.runtimeMode,
                    interactionMode: command.interactionMode,
                    branch: command.branch,
                    worktreePath: command.worktreePath,
                    updatedAt: command.createdAt,
                    lastInteractionAt: command.createdAt,
                  })
                : thread,
            )
          : [
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
                updatedAt: command.createdAt,
                lastInteractionAt: command.createdAt,
              }),
            ],
        updatedAt: command.createdAt,
      };

    case "thread.proposed-plan.upsert":
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === command.threadId
            ? {
                ...thread,
                proposedPlans: thread.proposedPlans.some(
                  (plan) => plan.id === command.proposedPlan.id,
                )
                  ? thread.proposedPlans.map((plan) =>
                      plan.id === command.proposedPlan.id ? command.proposedPlan : plan,
                    )
                  : [...thread.proposedPlans, command.proposedPlan],
                updatedAt: command.createdAt,
                lastInteractionAt: command.createdAt,
              }
            : thread,
        ),
        updatedAt: command.createdAt,
      };

    case "project.workflow.create": {
      const workflow: PlanningWorkflow = {
        id: command.workflowId,
        projectId: command.projectId,
        title: command.title,
        slug: command.slug,
        requirementPrompt: command.requirementPrompt,
        plansDirectory: command.plansDirectory,
        selfReviewEnabled: command.selfReviewEnabled,
        branchA: {
          branchId: "a",
          authorSlot: command.branchA,
          authorThreadId: command.authorThreadIdA,
          planFilePath: null,
          planTurnId: null,
          revisionTurnId: null,
          reviews: [],
          status: "pending",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: command.createdAt,
        },
        branchB: {
          branchId: "b",
          authorSlot: command.branchB,
          authorThreadId: command.authorThreadIdB,
          planFilePath: null,
          planTurnId: null,
          revisionTurnId: null,
          reviews: [],
          status: "pending",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: command.createdAt,
        },
        merge: {
          mergeSlot: command.merge,
          threadId: null,
          outputFilePath: null,
          turnId: null,
          approvedPlanId: null,
          status: "not_started",
          error: null,
          updatedAt: command.createdAt,
        },
        implementation: null,
        totalCostUsd: 0,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        archivedAt: null,
        deletedAt: null,
      };
      return {
        ...snapshot,
        planningWorkflows: [...snapshot.planningWorkflows, workflow],
        updatedAt: command.createdAt,
      };
    }

    case "project.workflow.upsert":
      return {
        ...snapshot,
        planningWorkflows: snapshot.planningWorkflows.some(
          (workflow) => workflow.id === command.workflow.id,
        )
          ? snapshot.planningWorkflows.map((workflow) =>
              workflow.id === command.workflow.id ? command.workflow : workflow,
            )
          : [...snapshot.planningWorkflows, command.workflow],
        updatedAt: command.createdAt,
      };

    case "project.workflow.delete":
      return {
        ...snapshot,
        planningWorkflows: snapshot.planningWorkflows.map((workflow) =>
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

function applyWorkflowEventToSnapshot(
  snapshot: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  switch (event.type) {
    case "thread.session-set":
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === event.payload.threadId
            ? {
                ...thread,
                session: event.payload.session,
                updatedAt: event.occurredAt,
              }
            : thread,
        ),
        updatedAt: event.occurredAt,
      };

    default:
      return snapshot;
  }
}

async function createHarness(initialSnapshot: OrchestrationReadModel) {
  let snapshot = initialSnapshot;
  let projectionSnapshotsFailing = false;
  let projectionSnapshotCallCount = 0;
  const dispatched: OrchestrationCommand[] = [];
  const queue = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());
  const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "disabled in WorkflowService test harness",
      }),
    ),
  );

  const createWorktree = vi.fn<GitCoreShape["createWorktree"]>((input) =>
    Effect.succeed({
      worktree: {
        path: `${input.cwd}/.t3/worktrees/${input.newBranch ?? "worktree"}`,
        branch: input.newBranch ?? "mocked-worktree-branch",
      },
    }),
  );

  const engine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(snapshot),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        snapshot = applyWorkflowCommandToSnapshot(snapshot, command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.fromQueue(queue),
  };

  const runtime = ManagedRuntime.make(
    WorkflowServiceLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.suspend(() => {
              projectionSnapshotCallCount += 1;
              return projectionSnapshotsFailing
                ? Effect.die(new Error("Projection snapshot disabled by WorkflowService test."))
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
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          createWorktree,
        } as unknown as GitCoreShape),
      ),
    ),
  );

  const service = await runtime.runPromise(Effect.service(WorkflowService));
  let closeStartScope: (() => Promise<void>) | null = null;

  return {
    service,
    dispatched,
    generateThreadTitle,
    createWorktree,
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
      snapshot = applyWorkflowEventToSnapshot(snapshot, event);
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

describe("WorkflowService", () => {
  let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (harness) {
      await harness.dispose();
    }
    harness = null;
  });

  it("rejects startImplementation unless the merge is ready for manual review", async () => {
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        status: "in_progress",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [makeThread({ id: ThreadId.makeUnsafe("merge-thread") })],
      }),
    );

    await expect(
      Effect.runPromise(
        harness.service.startImplementation({
          workflowId: workflow.id,
          provider: "codex",
          model: "gpt-5-codex",
        }),
      ),
    ).rejects.toThrow("not ready for implementation");
  });

  it("starts workflow authoring threads in plan interaction mode", async () => {
    harness = await createHarness(makeReadModel({}));

    await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Workflow",
        requirementPrompt: "Investigate the bug and propose a fix",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const authorCommands = harness.dispatched.filter(
      (
        command,
      ): command is Extract<
        OrchestrationCommand,
        { type: "thread.create" | "thread.turn.start" }
      > =>
        (command.type === "thread.create" && command.branch !== null) ||
        command.type === "thread.turn.start",
    );

    expect(authorCommands).not.toHaveLength(0);
    expect(authorCommands.every((command) => command.interactionMode === "plan")).toBe(true);
    const authorTurns = authorCommands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    expect(
      authorTurns.find((command) => command.provider === "claudeAgent")?.message.text,
    ).toContain("Prefer dedicated tools over shell commands");
    expect(authorTurns.find((command) => command.provider === "codex")?.message.text).toContain(
      "prefer `rg` and `rg --files`",
    );
  });

  it("creates workflow thread titles without repeating the workflow name", async () => {
    harness = await createHarness(makeReadModel({}));

    await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Code review-only workflow",
        requirementPrompt: "Investigate the bug and propose a fix",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const createdTitles = harness.dispatched
      .filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
          command.type === "thread.create",
      )
      .map((command) => command.title);

    expect(createdTitles).toContain("Branch A");
    expect(createdTitles).toContain("Branch B");
    expect(createdTitles).not.toContain("Code review-only workflow Branch A");
    expect(createdTitles).not.toContain("Code review-only workflow Branch B");
  });

  it("creates a fallback-titled workflow immediately and upserts the generated title later", async () => {
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
        requirementPrompt: "  Build workflow auto-title generation.  ",
        titleGenerationModel: "custom/title-model",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    const createCommand = activeHarness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "project.workflow.create" }> =>
        command.type === "project.workflow.create",
    );
    expect(workflowId).toBe(createCommand?.workflowId);
    expect(createCommand?.title).toBe("Build workflow auto-title generation");

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    expect(activeHarness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/project",
      message: "  Build workflow auto-title generation.  ",
      model: "custom/title-model",
    });
    expect(
      activeHarness.getSnapshot().planningWorkflows.find((workflow) => workflow.id === workflowId)
        ?.title,
    ).toBe("Build workflow auto-title generation");

    generatedTitle.resolve({ title: "Ship automatic workflow titles" });
    await activeHarness.drain();

    expect(
      activeHarness.getSnapshot().planningWorkflows.find((workflow) => workflow.id === workflowId)
        ?.title,
    ).toBe("Ship automatic workflow titles");
  });

  it("skips workflow title generation when a manual title is provided", async () => {
    harness = await createHarness(makeReadModel({}));

    await Effect.runPromise(
      harness.service.createWorkflow({
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Manual workflow title",
        requirementPrompt: "Build workflow auto-title generation",
        titleGenerationModel: "custom/title-model",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await harness.drain();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(
      harness.dispatched.find(
        (command): command is Extract<OrchestrationCommand, { type: "project.workflow.create" }> =>
          command.type === "project.workflow.create",
      )?.title,
    ).toBe("Manual workflow title");
  });

  it("does not upsert a generated title after the workflow is deleted", async () => {
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
        requirementPrompt: "Review workflow title deletion races",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(activeHarness.service.deleteWorkflow(workflowId));

    generatedTitle.resolve({ title: "Should not apply" });
    await activeHarness.drain();

    const workflow = activeHarness
      .getSnapshot()
      .planningWorkflows.find((entry) => entry.id === workflowId);
    expect(workflow?.deletedAt).not.toBeNull();
    expect(workflow?.title).toBe("Review workflow title deletion races");
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
        requirementPrompt: "Review workflow title archive races",
        selfReviewEnabled: true,
        branchA: { provider: "codex", model: "gpt-5-codex" },
        branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        merge: { provider: "codex", model: "gpt-5-codex" },
      }),
    );

    await waitFor(() => activeHarness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(activeHarness.service.archiveWorkflow(workflowId));

    generatedTitle.resolve({ title: "Archived workflow title still updates" });
    await activeHarness.drain();

    const workflow = activeHarness
      .getSnapshot()
      .planningWorkflows.find((entry) => entry.id === workflowId);
    expect(workflow?.archivedAt).not.toBeNull();
    expect(workflow?.title).toBe("Archived workflow title still updates");
  });

  it("archives and unarchives workflows without deleting them", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(makeReadModel({ workflow }));

    await Effect.runPromise(harness.service.archiveWorkflow(workflow.id));

    const archivedWorkflow = harness
      .getSnapshot()
      .planningWorkflows.find((entry) => entry.id === workflow.id);
    expect(archivedWorkflow?.archivedAt).not.toBeNull();
    expect(archivedWorkflow?.deletedAt).toBeNull();

    await Effect.runPromise(harness.service.unarchiveWorkflow(workflow.id));

    const unarchivedWorkflow = harness
      .getSnapshot()
      .planningWorkflows.find((entry) => entry.id === workflow.id);
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
      id: PlanningWorkflowId.makeUnsafe("workflow-2"),
    });
    harness = await createHarness(makeReadModel({ workflow: activeWorkflow }));

    await expect(
      Effect.runPromise(harness.service.unarchiveWorkflow(activeWorkflow.id)),
    ).rejects.toThrow("is not archived");
  });

  it("rejects startImplementation when implementation already exists", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [makeThread({ id: ThreadId.makeUnsafe("merge-thread") })],
      }),
    );

    await expect(
      Effect.runPromise(
        harness.service.startImplementation({
          workflowId: workflow.id,
          provider: "codex",
          model: "gpt-5-codex",
        }),
      ),
    ).rejects.toThrow("already been started");
  });

  it("allows startImplementation for archived workflows", async () => {
    const workflow = makeWorkflow({ archivedAt: NOW });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.startImplementation({
        workflowId: workflow.id,
        provider: "codex",
        model: "gpt-5-codex",
      }),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "implementing",
    );
  });

  it("allows retryWorkflow for archived workflows", async () => {
    const workflow = makeWorkflow({
      archivedAt: NOW,
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "Authoring failed.",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }));

    await Effect.runPromise(harness.service.retryWorkflow(workflow.id));

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("pending");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.archivedAt).toBe(NOW);
  });

  it("starts implementation from the pinned approved merged plan and links sourceProposedPlan", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "older-plan",
                turnId: TurnId.makeUnsafe("merge-turn-old"),
                planMarkdown: "# Older plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn-approved"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: "latest-plan",
                turnId: TurnId.makeUnsafe("merge-turn-latest"),
                planMarkdown: "# Latest plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.startImplementation({
        workflowId: workflow.id,
        provider: "codex",
        model: "gpt-5-codex",
        runtimeMode: "approval-required",
      }),
    );

    const turnStart = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    const threadCreate = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create",
    );
    const workflowUpsert = lastWorkflowUpsert(harness.dispatched);

    expect(threadCreate).toBeDefined();
    if (!threadCreate) {
      throw new Error("Expected implementation thread.create command.");
    }

    expect(threadCreate?.threadReferences).toHaveLength(1);
    expect(threadCreate.threadReferences?.[0]).toMatchObject({
      relation: "source",
      threadId: "merge-thread",
    });
    expect(typeof threadCreate.threadReferences?.[0]?.createdAt).toBe("string");
    expect(turnStart?.sourceProposedPlan).toEqual({
      threadId: "merge-thread",
      planId: "approved-plan",
    });
    expect(turnStart?.message.text).toContain("# Approved plan");
    expect(turnStart?.message.text).toContain(
      "Read the relevant existing code before modifying it",
    );
    expect(turnStart?.message.text).toContain("prefer `rg` and `rg --files`");
    expect(turnStart?.interactionMode).toBe("default");
    expect(workflowUpsert?.workflow.implementation?.status).toBe("implementing");
  });

  it("starts implementation with envMode=local and does not invoke createWorktree", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.startImplementation({
        workflowId: workflow.id,
        provider: "codex",
        model: "gpt-5-codex",
        envMode: "local",
      }),
    );

    const threadCreate = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create",
    );
    expect(threadCreate?.branch).toBeNull();
    expect(threadCreate?.worktreePath).toBeNull();
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("creates a worktree and links branch/path on thread.create when envMode=worktree", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(
      harness.service.startImplementation({
        workflowId: workflow.id,
        provider: "codex",
        model: "gpt-5-codex",
        envMode: "worktree",
        baseBranch: "main",
      }),
    );

    expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    const createWorktreeArgs = harness.createWorktree.mock.calls[0]?.[0];
    expect(createWorktreeArgs?.cwd).toBe("/tmp/project");
    expect(createWorktreeArgs?.branch).toBe("main");
    expect(createWorktreeArgs?.path).toBeNull();
    expect(typeof createWorktreeArgs?.newBranch).toBe("string");

    const threadCreate = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create",
    );
    expect(threadCreate?.branch).toBe(createWorktreeArgs?.newBranch);
    expect(threadCreate?.worktreePath).toBe(
      `/tmp/project/.t3/worktrees/${createWorktreeArgs?.newBranch}`,
    );
  });

  it("rejects startImplementation when envMode=worktree without a base branch", async () => {
    const workflow = makeWorkflow();
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await expect(
      Effect.runPromise(
        harness.service.startImplementation({
          workflowId: workflow.id,
          provider: "codex",
          model: "gpt-5-codex",
          envMode: "worktree",
        }),
      ),
    ).rejects.toThrow("base branch is required");
    expect(harness.createWorktree).not.toHaveBeenCalled();
  });

  it("does not start code reviews from diff capture while the implementation turn is still running", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("implementation-turn"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-old"),
                role: "assistant",
                text: "Old implementation output",
                turnId: TurnId.makeUnsafe("older-turn"),
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
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        turnId: TurnId.makeUnsafe("implementation-turn"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title.includes("Code Review"),
      ),
    ).toBe(false);
    expect(lastWorkflowUpsert(harness.dispatched)).toBeNull();
  });

  it("starts code reviews exactly once after the implementation reaches a final ready state", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("implementation-turn"),
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
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-implementation"),
                role: "assistant",
                text: "Implementation complete",
                turnId: TurnId.makeUnsafe("implementation-turn"),
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
      threadId: ThreadId.makeUnsafe("implementation-thread"),
      session: {
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });

    await harness.emit(readyEvent);

    await waitFor(() => {
      const createdReviewThreads = harness!.dispatched.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
          command.type === "thread.create" && command.title.includes("Code Review"),
      );
      return createdReviewThreads.length === 2;
    });

    await harness.emit(readyEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const createdReviewThreads = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create" && command.title.includes("Code Review"),
    );
    const reviewTurnStarts = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.threadId !== ThreadId.makeUnsafe("implementation-thread"),
    );
    const latestUpsert = lastWorkflowUpsert(harness.dispatched);

    expect(createdReviewThreads).toHaveLength(2);
    expect(createdReviewThreads.map((command) => command.title)).toEqual([
      "Code Review (Author A (codex:gpt-5-codex))",
      "Code Review (Author B (claudeAgent:claude-sonnet-4-5))",
    ]);
    expect(
      reviewTurnStarts.find((command) => command.provider === "claudeAgent")?.message.text,
    ).toContain("Prefer dedicated tools over shell commands");
    expect(reviewTurnStarts[0]?.message.text).toContain("file_path:line_number");
    expect(latestUpsert?.workflow.implementation?.status).toBe("code_reviews_requested");
    expect(latestUpsert?.workflow.implementation?.codeReviews).toHaveLength(2);
  });

  it("reconciles a finished implementation thread on service start", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-implementation"),
                role: "assistant",
                text: "Implementation complete",
                turnId: TurnId.makeUnsafe("implementation-turn"),
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
        (command) => command.type === "thread.create" && command.title.includes("Code Review"),
      ),
    );

    const createdReviewThreads = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create" && command.title.includes("Code Review"),
    );

    expect(createdReviewThreads).toHaveLength(2);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "code_reviews_requested",
    );
  });

  it("does not mark stopped implementation sessions as errors when the latest turn already completed on startup", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-implementation"),
                role: "assistant",
                text: "Implementation complete",
                turnId: TurnId.makeUnsafe("implementation-turn"),
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
        (command) => command.type === "thread.create" && command.title.includes("Code Review"),
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "code_reviews_requested",
    );
  });

  it("skips code review and completes when codeReviewEnabled is false", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: false,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("implementation-turn"),
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
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-implementation"),
                role: "assistant",
                text: "Implementation complete",
                turnId: TurnId.makeUnsafe("implementation-turn"),
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
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        session: {
          threadId: ThreadId.makeUnsafe("implementation-thread"),
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
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "completed",
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "completed",
    );
  });

  it("processes implementation completion events for archived workflows", async () => {
    const workflow = makeWorkflow({
      archivedAt: NOW,
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: false,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("implementation-turn"),
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
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-implementation"),
                role: "assistant",
                text: "Implementation complete",
                turnId: TurnId.makeUnsafe("implementation-turn"),
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
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        session: {
          threadId: ThreadId.makeUnsafe("implementation-thread"),
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
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "completed",
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "completed",
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.archivedAt).toBe(NOW);
  });

  it("starts an implementation revision turn once all code reviews complete", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
          {
            reviewerLabel: "Author B (claudeAgent:claude-sonnet-4-5)",
            reviewerSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
            threadId: ThreadId.makeUnsafe("code-review-b"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "code_reviews_requested",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("code-review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("code-review-b"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("review-turn-b"),
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
            id: ThreadId.makeUnsafe("code-review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("code-review-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "Finding B",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
        threadId: ThreadId.makeUnsafe("code-review-b"),
        session: {
          threadId: ThreadId.makeUnsafe("code-review-b"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("implementation-thread"),
      ),
    );

    const revisionTurn = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.threadId === ThreadId.makeUnsafe("implementation-thread"),
    );

    expect(revisionTurn?.message.text).toContain("Finding A");
    expect(revisionTurn?.message.text).toContain("Finding B");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "applying_reviews",
    );
  });

  it("starts an implementation revision turn when the final code review is reasoning-only", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
          {
            reviewerLabel: "Author B (claudeAgent:claude-sonnet-4-5)",
            reviewerSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
            threadId: ThreadId.makeUnsafe("code-review-b"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "code_reviews_requested",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("code-review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("code-review-b"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("review-turn-b"),
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
            id: ThreadId.makeUnsafe("code-review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("code-review-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-b"),
                role: "assistant",
                text: "",
                reasoningText: "Reasoning-only Finding B",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
        threadId: ThreadId.makeUnsafe("code-review-b"),
        session: {
          threadId: ThreadId.makeUnsafe("code-review-b"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("implementation-thread"),
      ),
    );

    const revisionTurn = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.threadId === ThreadId.makeUnsafe("implementation-thread"),
    );

    expect(revisionTurn?.message.text).toContain("Finding A");
    expect(revisionTurn?.message.text).toContain("Reasoning-only Finding B");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "applying_reviews",
    );
  });

  it("does not mark stopped code review sessions as errors when the latest turn already completed on startup", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "code_reviews_requested",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: ThreadId.makeUnsafe("implementation-thread") }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "stopped",
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
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
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

    await waitFor(
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "applying_reviews",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "applying_reviews",
    );
  });

  it("marks implementation and code review failures on session errors", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "code_reviews_requested",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(makeReadModel({ workflow, threads: [] }));
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("code-review-a"),
        session: {
          threadId: ThreadId.makeUnsafe("code-review-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "review failed",
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "error",
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe("error");
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.codeReviews[0]?.status,
    ).toBe("error");
  });

  it("does not mark plan reviews completed when a review session becomes ready", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
      branchB: {
        ...makeWorkflow().branchB,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            session: {
              threadId: ThreadId.makeUnsafe("review-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            session: {
              threadId: ThreadId.makeUnsafe("review-b"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("review-turn-b"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("review-a"),
        session: {
          threadId: ThreadId.makeUnsafe("review-a"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lastWorkflowUpsert(harness.dispatched)).toBeNull();
  });

  it("returns review comments to authors when a ready review session has assistant output", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      branchB: {
        ...makeWorkflow().branchB,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
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
                text: "Finding B",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("review-b"),
        session: {
          threadId: ThreadId.makeUnsafe("review-b"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("author-a"),
      ),
    );

    const revisionTurns = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        (command.threadId === ThreadId.makeUnsafe("author-a") ||
          command.threadId === ThreadId.makeUnsafe("author-b")),
    );

    expect(revisionTurns).toHaveLength(2);
    expect(revisionTurns.every((command) => command.message.text.includes("Finding"))).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("revising");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revising");
  });

  it("returns reasoning-only review output to authors when the final review chat completes", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      branchB: {
        ...makeWorkflow().branchB,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
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
                text: "",
                reasoningText: "Reasoning-only review finding",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("review-b"),
        session: {
          threadId: ThreadId.makeUnsafe("review-b"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("author-a"),
      ),
    );

    const revisionTurns = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        (command.threadId === ThreadId.makeUnsafe("author-a") ||
          command.threadId === ThreadId.makeUnsafe("author-b")),
    );

    expect(revisionTurns).toHaveLength(2);
    expect(revisionTurns.some((command) => command.message.text.includes("Finding A"))).toBe(true);
    expect(
      revisionTurns.some((command) =>
        command.message.text.includes("Reasoning-only review finding"),
      ),
    ).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("revising");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revising");
  });

  it("includes reviewer reasoning when the assistant text is empty", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      branchB: {
        ...makeWorkflow().branchB,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                // Empty text simulates a Codex reviewer that only emitted reasoning.
                text: "",
                reasoningText: "Substantive findings delivered via reasoning channel.",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
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
                text: "Preamble text.",
                reasoningText: "Detailed findings.",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("review-b"),
        session: {
          threadId: ThreadId.makeUnsafe("review-b"),
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
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("author-a"),
      ),
    );

    const revisionForA = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.threadId === ThreadId.makeUnsafe("author-a"),
    );
    const revisionForB = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.threadId === ThreadId.makeUnsafe("author-b"),
    );

    // Reasoning-only review: the revision prompt must carry the reasoning content.
    expect(revisionForA?.message.text).toContain(
      "Substantive findings delivered via reasoning channel.",
    );
    // Mixed review: both text and reasoning must be preserved.
    expect(revisionForB?.message.text).toContain("Preamble text.");
    expect(revisionForB?.message.text).toContain("## Reviewer reasoning");
    expect(revisionForB?.message.text).toContain("Detailed findings.");
  });

  it("retries returning saved review comments once the assistant message is projected", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      branchB: {
        ...makeWorkflow().branchB,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "completed",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_saved",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
            },
            messages: [],
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("review-b"),
        turnId: TurnId.makeUnsafe("review-turn-b"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-review-b"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("author-a"),
      ),
    ).toBe(false);

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-review-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-review-a"),
                role: "assistant",
                text: "Finding A",
                turnId: TurnId.makeUnsafe("review-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-b"),
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
                text: "Finding B",
                turnId: TurnId.makeUnsafe("review-turn-b"),
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
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("review-b"),
        messageId: MessageId.makeUnsafe("assistant-review-b"),
        role: "assistant",
        text: "Finding B",
        turnId: TurnId.makeUnsafe("review-turn-b"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === ThreadId.makeUnsafe("author-a"),
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("revising");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revising");
  });

  it("retries the revision-to-merge handoff once revised author output is projected", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: "revision-turn-a",
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: null,
        status: "revising",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "Revised plan A",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: "plan-a",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("author-b"),
        turnId: TurnId.makeUnsafe("revision-turn-b"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-author-b"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    ).toBe(false);

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "Revised plan A",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: "plan-a",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b"),
                role: "assistant",
                text: "Revised plan B",
                turnId: TurnId.makeUnsafe("revision-turn-b"),
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
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("author-b"),
        messageId: MessageId.makeUnsafe("assistant-author-b"),
        role: "assistant",
        text: "Revised plan B",
        turnId: TurnId.makeUnsafe("revision-turn-b"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revised");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
  });

  it("synthesizes a revised plan from reasoning-only author output and starts merge", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: "revision-turn-a",
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: null,
        status: "revising",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "Revised plan A",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: "plan-a",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("author-b"),
        turnId: TurnId.makeUnsafe("revision-turn-b"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-author-b"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    ).toBe(false);

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "Revised plan A",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: "plan-a",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b"),
                role: "assistant",
                text: "",
                reasoningText: "Reasoning-only revised plan B",
                turnId: TurnId.makeUnsafe("revision-turn-b"),
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
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("author-b"),
        messageId: MessageId.makeUnsafe("assistant-author-b"),
        role: "assistant",
        text: "",
        reasoningText: "Reasoning-only revised plan B",
        turnId: TurnId.makeUnsafe("revision-turn-b"),
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.proposed-plan.upsert" &&
          command.threadId === ThreadId.makeUnsafe("author-b") &&
          command.proposedPlan.planMarkdown === "Reasoning-only revised plan B",
      ),
    ).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revised");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
  });

  it("ignores stale proposed-plan upserts while a branch is revising", async () => {
    const oldPlanTurnId = TurnId.makeUnsafe("plan-turn-old");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: oldPlanTurnId,
        revisionTurnId: TurnId.makeUnsafe("revision-turn-new"),
        status: "revising",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: oldPlanTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-old"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-plan-old"),
                role: "assistant",
                text: "Original plan",
                turnId: oldPlanTurnId,
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

    const workflowUpsertCountBefore = harness.dispatched.filter(
      (command) => command.type === "project.workflow.upsert",
    ).length;

    await harness.emit(
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("author-a"),
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe("plan-old"),
          turnId: oldPlanTurnId,
          planMarkdown: "Original plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.filter((command) => command.type === "project.workflow.upsert"),
    ).toHaveLength(workflowUpsertCountBefore);
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    ).toBe(false);
  });

  it("ignores late proposed-plan upserts after reviews have started", async () => {
    const planTurnId = TurnId.makeUnsafe("plan-turn-a");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId,
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-a"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: TurnId.makeUnsafe("plan-turn-b"),
        reviews: [
          {
            slot: "cross",
            threadId: ThreadId.makeUnsafe("review-b"),
            outputFilePath: null,
            status: "running",
            error: null,
            updatedAt: NOW,
          },
        ],
        status: "reviews_requested",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: planTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-plan-a"),
                role: "assistant",
                text: "Plan A",
                turnId: planTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: planTurnId,
                planMarkdown: "Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-a"),
            session: {
              threadId: ThreadId.makeUnsafe("review-a"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("review-turn-a"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
          makeThread({
            id: ThreadId.makeUnsafe("review-b"),
            session: {
              threadId: ThreadId.makeUnsafe("review-b"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("review-turn-b"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    const workflowUpsertCountBefore = harness.dispatched.filter(
      (command) => command.type === "project.workflow.upsert",
    ).length;

    await harness.emit(
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("author-a"),
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe("plan-a-late"),
          turnId: planTurnId,
          planMarkdown: "Plan A",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.filter((command) => command.type === "project.workflow.upsert"),
    ).toHaveLength(workflowUpsertCountBefore);
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("reviews_requested");
  });

  it("starts reviews from a ready author session without querying the projection snapshot", async () => {
    const planTurnIdA = TurnId.makeUnsafe("plan-turn-a");
    const planTurnIdB = TurnId.makeUnsafe("plan-turn-b");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: planTurnIdB,
        status: "plan_saved",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: planTurnIdA,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: planTurnIdA,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-plan-a"),
                role: "assistant",
                text: "Plan A",
                turnId: planTurnIdA,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: planTurnIdA,
                planMarkdown: "Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: planTurnIdB,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-plan-b"),
                role: "assistant",
                text: "Plan B",
                turnId: planTurnIdB,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b"),
                turnId: planTurnIdB,
                planMarkdown: "Plan B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    const projectionSnapshotCallsBefore = harness.getProjectionSnapshotCallCount();
    harness.failProjectionSnapshots();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
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
      () =>
        lastWorkflowUpsert(harness!.dispatched)?.workflow.branchA.status === "reviews_requested",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe(
      "reviews_requested",
    );
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title.includes("Review"),
      ),
    ).toBe(true);
    expect(harness.getProjectionSnapshotCallCount()).toBe(projectionSnapshotCallsBefore);
  });

  it("does not synthesize a revised plan from stale assistant text on a reused author thread", async () => {
    const oldPlanTurnId = TurnId.makeUnsafe("plan-turn-old");
    const revisionTurnId = TurnId.makeUnsafe("revision-turn-new");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: oldPlanTurnId,
        revisionTurnId,
        status: "revising",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: oldPlanTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-old"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-plan-old"),
                role: "assistant",
                text: "Original plan that must not be reused",
                turnId: oldPlanTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-old"),
                turnId: oldPlanTurnId,
                planMarkdown: "Original plan that must not be reused",
                implementedAt: null,
                implementationThreadId: null,
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
        threadId: ThreadId.makeUnsafe("author-a"),
        turnId: revisionTurnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-revision"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: NOW,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.proposed-plan.upsert" &&
          command.proposedPlan.turnId === revisionTurnId,
      ),
    ).toBe(false);
  });

  it("auto-retries authoring turns on retryable session errors", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "429 too many requests for api key pool",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("authoring");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      1,
    );
  });

  it("marks authoring errors once automatic retries are exhausted", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
        retryCount: 2,
        lastRetryAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "rate limit exceeded",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBe(
      "rate limit exceeded | provider: codex",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      0,
    );
  });

  it("does not auto-retry non-retryable authoring errors", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();
    await vi.advanceTimersByTimeAsync(1);

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "authentication failed",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBe(
      "authentication failed | provider: codex",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      0,
    );
  });

  it("skips stale auto-retries when the workflow is deleted during backoff", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "503 overloaded",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(1);

    await Effect.runPromise(harness.service.deleteWorkflow(workflow.id));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      0,
    );
  });

  it("auto-retries implementation turns on retryable session errors", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("implementation-turn"),
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("implementation-user-message"),
                role: "user",
                text: "Apply the implementation plan",
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
    await vi.advanceTimersByTimeAsync(1);

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        session: {
          threadId: ThreadId.makeUnsafe("implementation-thread"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "timeout while generating response",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "implementing",
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.retryCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("implementation-thread")),
    ).toHaveLength(1);

    expect(
      turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("implementation-thread"))[0]
        ?.message.text,
    ).toBe("Apply the implementation plan");
  });

  it("auto-retries code review turns on retryable session errors", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "code_reviews_requested",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("code-review-a"),
            session: {
              threadId: ThreadId.makeUnsafe("code-review-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("code-review-turn-a"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();
    await vi.advanceTimersByTimeAsync(1);

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("code-review-a"),
        session: {
          threadId: ThreadId.makeUnsafe("code-review-a"),
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "429 from provider",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "code_reviews_requested",
    );
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.codeReviews[0]?.retryCount,
    ).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("code-review-a")),
    ).toHaveLength(1);
  });

  it("resets retry counters on manual retry", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        retryCount: 2,
        lastRetryAt: NOW,
      },
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "error",
            error: "review failed",
            retryCount: 1,
            lastRetryAt: NOW,
            updatedAt: NOW,
          },
        ],
        status: "error",
        error: "implementation failed",
        retryCount: 2,
        lastRetryAt: NOW,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            proposedPlans: [
              {
                id: "approved-plan",
                turnId: TurnId.makeUnsafe("merge-turn"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(harness.service.retryWorkflow(workflow.id));

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(0);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.lastRetryAt).toBeNull();
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.retryCount).toBe(0);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.lastRetryAt).toBeNull();
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.codeReviews[0]?.retryCount,
    ).toBe(0);
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.codeReviews[0]?.lastRetryAt,
    ).toBeNull();
  });

  it("reconciles authoring branches with errored sessions on startup", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "error",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "provider crashed",
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(
      () => (lastWorkflowUpsert(harness!.dispatched)?.workflow.branchA.status ?? "") === "error",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBe(
      "Authoring session was not running during reconciliation.",
    );
  });

  it("reconciles pending branches by re-dispatching authoring turns on startup", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "pending",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(
      () => turnStartsForThread(harness!.dispatched, ThreadId.makeUnsafe("author-a")).length === 1,
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("authoring");
  });

  it("reconciles completed revision output into a merge on startup", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: "revision-turn-a",
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: null,
        status: "revising",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: null,
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "not_started",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-a"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "Revised plan A",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: "plan-a",
                turnId: TurnId.makeUnsafe("revision-turn-a"),
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("revision-turn-b"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b"),
                role: "assistant",
                text: "Revised plan B",
                turnId: TurnId.makeUnsafe("revision-turn-b"),
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

    await waitFor(
      () =>
        harness!.dispatched.some(
          (command) => command.type === "thread.create" && command.title === "Merge",
        ),
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revised");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
  });

  it("reconciles implementing workflows with stopped sessions on startup", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "error",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.error).toBe(
      "Implementation session was not running during reconciliation.",
    );
  });

  it("reconciles revising branches with stopped sessions on startup", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "revising",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(
      () => (lastWorkflowUpsert(harness!.dispatched)?.workflow.branchA.status ?? "") === "error",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBe(
      "Revision session was not running during reconciliation.",
    );
  });

  it("reconciles applying review workflows with stopped sessions on startup", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: "implementation-turn",
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "applying_reviews",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("implementation-thread"),
            latestTurn: {
              turnId: TurnId.makeUnsafe("implementation-revision-turn"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("implementation-thread"),
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [],
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(
      () =>
        (lastWorkflowUpsert(harness!.dispatched)?.workflow.implementation?.status ?? "") ===
        "error",
      100,
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.error).toBe(
      "Implementation revision session was not running during reconciliation.",
    );
  });

  it("skips archived and deleted workflows during startup reconciliation", async () => {
    const archivedWorkflow = makeWorkflow({
      id: PlanningWorkflowId.makeUnsafe("workflow-archived"),
      archivedAt: NOW,
      branchA: {
        ...makeWorkflow().branchA,
        status: "pending",
      },
    });
    const deletedWorkflow = makeWorkflow({
      id: PlanningWorkflowId.makeUnsafe("workflow-deleted"),
      deletedAt: NOW,
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness({
      ...makeReadModel({ threads: [] }),
      planningWorkflows: [archivedWorkflow, deletedWorkflow],
    });

    await harness.start();

    expect(harness.dispatched).toHaveLength(0);
  });

  it("accumulates totalCostUsd from workflow thread session updates", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [makeThread({ id: ThreadId.makeUnsafe("implementation-thread") })],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          turnCostUsd: 0.12,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(
      () => (lastWorkflowUpsert(harness!.dispatched)?.workflow.totalCostUsd ?? 0) === 0.12,
      100,
    );

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        session: {
          threadId: ThreadId.makeUnsafe("implementation-thread"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          turnCostUsd: 0.34,
          updatedAt: NOW,
        },
      }),
    );

    await waitFor(
      () => (lastWorkflowUpsert(harness!.dispatched)?.workflow.totalCostUsd ?? 0) === 0.46,
      100,
    );
  });

  it("transitions from automatic retries to a permanent error after the final retryable failure", async () => {
    vi.useFakeTimers();
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();

    const sessionErrorEvent = makeEvent("thread.session-set", {
      threadId: ThreadId.makeUnsafe("author-a"),
      session: {
        threadId: ThreadId.makeUnsafe("author-a"),
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "503 overloaded",
        updatedAt: NOW,
      },
    });

    await harness.emit(sessionErrorEvent);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      1,
    );

    await harness.emit(sessionErrorEvent);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      2,
    );

    await harness.emit(sessionErrorEvent);
    await vi.advanceTimersByTimeAsync(1);

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("error");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.error).toBe(
      "503 overloaded | provider: codex",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      2,
    );
  });

  it("labels implementation and code review threads in workflowForThread", async () => {
    const workflow = makeWorkflow({
      implementation: {
        implementationSlot: { provider: "codex", model: "gpt-5-codex" },
        threadId: ThreadId.makeUnsafe("implementation-thread"),
        implementationTurnId: null,
        revisionTurnId: null,
        codeReviewEnabled: true,
        codeReviews: [
          {
            reviewerLabel: "Author A (codex:gpt-5-codex)",
            reviewerSlot: { provider: "codex", model: "gpt-5-codex" },
            threadId: ThreadId.makeUnsafe("code-review-a"),
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
        status: "implementing",
        error: null,
        retryCount: 0,
        lastRetryAt: null,
        updatedAt: NOW,
      },
    });
    harness = await createHarness(makeReadModel({ workflow, threads: [] }));

    await expect(
      Effect.runPromise(
        harness.service.workflowForThread(ThreadId.makeUnsafe("implementation-thread")),
      ),
    ).resolves.toMatchObject({ label: "Implementation" });
    await expect(
      Effect.runPromise(harness.service.workflowForThread(ThreadId.makeUnsafe("code-review-a"))),
    ).resolves.toMatchObject({ label: "Code review (Author A (codex:gpt-5-codex))" });
  });
});
