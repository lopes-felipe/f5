import { join } from "node:path";
import {
  CheckpointRef,
  CommandId,
  defaultInstanceIdForDriver,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type PlanningWorkflow,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
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
import { WorkflowService } from "../Services/WorkflowService.ts";
import { WorkflowServiceLive } from "./WorkflowService.ts";

const NOW = "2026-03-26T12:00:00.000Z";

function claudeProvider(models: ReadonlyArray<string>): ServerProvider {
  const driver = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version: models.includes("claude-opus-5") ? "2.1.220" : "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

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
      errorStage: null,
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
      errorStage: null,
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

function makeImplementation(
  overrides: Partial<NonNullable<PlanningWorkflow["implementation"]>> = {},
): NonNullable<PlanningWorkflow["implementation"]> {
  return {
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
    investigationWorkflows: [],
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

function makeProviderTurnDelivery(
  threadId: ThreadId,
  state: ProviderTurnDelivery["state"],
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
  };
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
          errorStage: null,
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
          errorStage: null,
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

    case "thread.proposed-plan-upserted":
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === event.payload.threadId
            ? {
                ...thread,
                proposedPlans: thread.proposedPlans.some(
                  (plan) => plan.id === event.payload.proposedPlan.id,
                )
                  ? thread.proposedPlans.map((plan) =>
                      plan.id === event.payload.proposedPlan.id ? event.payload.proposedPlan : plan,
                    )
                  : [...thread.proposedPlans, event.payload.proposedPlan],
                updatedAt: event.occurredAt,
                lastInteractionAt: event.occurredAt,
              }
            : thread,
        ),
        updatedAt: event.occurredAt,
      };

    case "thread.turn-diff-completed":
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === event.payload.threadId && thread.latestTurn?.turnId === event.payload.turnId
            ? {
                ...thread,
                latestTurn: {
                  ...thread.latestTurn,
                  state: event.payload.status === "error" ? "error" : "completed",
                  completedAt: event.payload.completedAt,
                  assistantMessageId:
                    event.payload.assistantMessageId ?? thread.latestTurn.assistantMessageId,
                },
                updatedAt: event.occurredAt,
                lastInteractionAt: event.occurredAt,
              }
            : thread,
        ),
        updatedAt: event.occurredAt,
      };

    case "thread.turn-processing-quiesced":
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          thread.id === event.payload.threadId && thread.latestTurn?.turnId === event.payload.turnId
            ? {
                ...thread,
                latestTurn: {
                  ...thread.latestTurn,
                  processingQuiescedAt: event.payload.processingQuiescedAt,
                },
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

async function createHarness(
  initialSnapshot: OrchestrationReadModel,
  options?: {
    readonly getProviders?: () => ReadonlyArray<ServerProvider>;
    readonly recheckDelivery?: ProviderTurnDeliveryWorkerShape["recheck"];
    readonly retryDelivery?: ProviderTurnDeliveryWorkerShape["retry"];
    readonly dispatchDefect?: (command: OrchestrationCommand) => Error | null;
  },
) {
  let snapshot = initialSnapshot;
  let projectionSnapshotsFailing = false;
  let projectionSnapshotCallCount = 0;
  const dispatched: OrchestrationCommand[] = [];
  const acceptedCommandIds = new Set<string>();
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
        path: input.path ?? `${input.cwd}/.f5/worktrees/${input.newBranch ?? "worktree"}`,
        branch: input.newBranch ?? "mocked-worktree-branch",
      },
    }),
  );
  const serverConfig = {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: "/tmp/workflow-service",
    baseDir: "/tmp/f5-workflow",
    stateDir: "/tmp/f5-workflow/userdata",
    dbPath: "/tmp/f5-workflow/userdata/state.sqlite",
    keybindingsConfigPath: "/tmp/f5-workflow/userdata/keybindings.json",
    worktreesDir: "/tmp/f5-workflow/worktrees",
    attachmentsDir: "/tmp/f5-workflow/userdata/attachments",
    logsDir: "/tmp/f5-workflow/userdata/logs",
    serverLogPath: "/tmp/f5-workflow/userdata/logs/server.log",
    providerLogsDir: "/tmp/f5-workflow/userdata/logs/provider",
    providerEventLogPath: "/tmp/f5-workflow/userdata/logs/provider/events.log",
    terminalLogsDir: "/tmp/f5-workflow/userdata/logs/terminals",
    anonymousIdPath: "/tmp/f5-workflow/userdata/anonymous-id",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    observabilityEnabled: false,
    acpHardeningEnabled: false,
  } satisfies ServerConfigShape;

  const engine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(snapshot),
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        if (acceptedCommandIds.has(command.commandId)) {
          return { sequence: dispatched.length };
        }
        const defect = options?.dispatchDefect?.(command) ?? null;
        if (defect) {
          throw defect;
        }
        acceptedCommandIds.add(command.commandId);
        dispatched.push(command);
        snapshot = applyWorkflowCommandToSnapshot(snapshot, command);
        return { sequence: dispatched.length };
      }),
    acquireMaintenanceLock: () => Scope.make("sequential"),
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
      Layer.provideMerge(
        Layer.succeed(GitCore, {
          createWorktree,
        } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(Layer.succeed(ServerConfig, serverConfig)),
      Layer.provideMerge(
        Layer.succeed(ProviderRegistry, {
          getProviders: Effect.sync(() => options?.getProviders?.() ?? []),
          refresh: () => Effect.sync(() => options?.getProviders?.() ?? []),
          refreshInstance: () => Effect.sync(() => options?.getProviders?.() ?? []),
          streamChanges: Stream.empty,
        } satisfies ProviderRegistryShape),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderTurnDeliveryWorker, {
          start: Effect.void,
          drain: Effect.void,
          outcomes: Stream.empty,
          acknowledgeOutcome: () => Effect.void,
          recheck: options?.recheckDelivery ?? (() => Effect.succeed(null)),
          retry:
            options?.retryDelivery ??
            (() => Effect.die(new Error("Unexpected provider delivery retry in test."))),
          discard: () => Effect.die(new Error("Unexpected provider delivery discard in test.")),
        } satisfies ProviderTurnDeliveryWorkerShape),
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

  async function expectPlanSavedBranchRepinSkipped(input: {
    readonly reviews?: PlanningWorkflow["branchA"]["reviews"];
    readonly mergeStatus?: PlanningWorkflow["merge"]["status"];
    readonly branchUpdatedAt?: string;
    readonly finalRequestedAt?: string;
    readonly trigger?: "message-sent" | "proposed-plan-upserted";
  }) {
    const savedTurnId = TurnId.makeUnsafe("saved-plan-turn-a");
    const finalTurnId = TurnId.makeUnsafe("final-turn-a");
    const savedAt = "2026-03-26T12:00:00.000Z";
    const finalAt = "2026-03-26T12:02:00.000Z";
    const mergeStatus = input.mergeStatus ?? "not_started";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: savedTurnId,
        reviews: input.reviews ?? [],
        status: "plan_saved",
        updatedAt: input.branchUpdatedAt ?? savedAt,
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: null,
        reviews: [],
        status: "authoring",
      },
      merge: {
        ...makeWorkflow().merge,
        threadId: mergeStatus === "not_started" ? null : ThreadId.makeUnsafe("merge-thread"),
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: mergeStatus,
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("author-a"),
            latestTurn: {
              turnId: finalTurnId,
              state: "completed",
              requestedAt: input.finalRequestedAt ?? finalAt,
              startedAt: input.finalRequestedAt ?? finalAt,
              completedAt: input.finalRequestedAt ?? finalAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-final-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: finalAt,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-saved-a"),
                role: "assistant",
                text: "SAVED_PLAN_A",
                turnId: savedTurnId,
                streaming: false,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
              {
                id: MessageId.makeUnsafe("assistant-final-a"),
                role: "assistant",
                text: "FINAL_PLAN_A_SHOULD_NOT_PIN",
                turnId: finalTurnId,
                streaming: false,
                createdAt: finalAt,
                updatedAt: finalAt,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("saved-plan-a"),
                turnId: savedTurnId,
                planMarkdown: "SAVED_PLAN_A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    if ((input.trigger ?? "proposed-plan-upserted") === "message-sent") {
      await harness.emit(
        makeEvent(
          "thread.message-sent",
          {
            threadId: ThreadId.makeUnsafe("author-a"),
            messageId: MessageId.makeUnsafe("assistant-final-a"),
            role: "assistant",
            text: "FINAL_PLAN_A_SHOULD_NOT_PIN",
            turnId: finalTurnId,
            streaming: false,
            createdAt: finalAt,
            updatedAt: finalAt,
          },
          finalAt,
        ),
      );
    } else {
      await harness.emit(
        makeEvent(
          "thread.proposed-plan-upserted",
          {
            threadId: ThreadId.makeUnsafe("author-a"),
            proposedPlan: {
              id: OrchestrationProposedPlanId.makeUnsafe("final-plan-a"),
              turnId: finalTurnId,
              planMarkdown: "FINAL_PLAN_A_SHOULD_NOT_PIN",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: finalAt,
              updatedAt: finalAt,
            },
          },
          finalAt,
        ),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    const currentWorkflow = harness.getSnapshot().planningWorkflows[0];
    expect(currentWorkflow?.branchA.planTurnId).toBe(savedTurnId);
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "project.workflow.upsert" &&
          command.workflow.branchA.planTurnId === finalTurnId,
      ),
    ).toBe(false);
  }

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

  it("resumes implementation setup from persisted intent after thread creation fails", async () => {
    const workflow = makeWorkflow({ templateId: "builtin.planning.dual", templateVersion: 2 });
    let failImplementationThreadCreate = true;
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
      {
        dispatchDefect: (command) => {
          if (
            failImplementationThreadCreate &&
            command.type === "thread.create" &&
            command.title === "Implementation"
          ) {
            failImplementationThreadCreate = false;
            return new Error("injected implementation thread creation failure");
          }
          return null;
        },
      },
    );

    await expect(
      Effect.runPromise(
        harness.service.startImplementation({
          workflowId: workflow.id,
          provider: "codex",
          model: "gpt-5-codex",
          runtimeMode: "auto-accept-edits",
        }),
      ),
    ).rejects.toThrow("injected implementation thread creation failure");

    const failed = harness.getSnapshot().planningWorkflows[0]?.implementation;
    expect(failed).toMatchObject({
      status: "error",
      errorStage: "implementation-start",
      runtimeMode: "auto-accept-edits",
      branch: null,
      worktreePath: null,
    });
    const intendedThreadId = failed?.threadId;
    expect(intendedThreadId).not.toBeNull();

    await expect(
      Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id })),
    ).resolves.toEqual({ status: "started" });

    expect(
      harness.dispatched.filter(
        (command) => command.type === "thread.create" && command.threadId === intendedThreadId,
      ),
    ).toHaveLength(1);
    expect(turnStartsForThread(harness.dispatched, intendedThreadId!)).toHaveLength(1);
    expect(harness.getSnapshot().planningWorkflows[0]?.implementation?.status).toBe("implementing");
  });

  it("does not duplicate implementation delivery when the post-dispatch upsert fails", async () => {
    const workflow = makeWorkflow({ templateId: "builtin.planning.dual", templateVersion: 2 });
    let turnWasDispatched = false;
    let failPostDispatchUpsert = true;
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
      {
        recheckDelivery: (threadId) =>
          Effect.succeed(
            turnWasDispatched
              ? {
                  ...makeProviderTurnDelivery(threadId, "pending"),
                  createdAt: "9999-12-31T23:59:59.999Z",
                }
              : null,
          ),
        dispatchDefect: (command) => {
          if (command.type === "thread.turn.start") turnWasDispatched = true;
          if (
            turnWasDispatched &&
            failPostDispatchUpsert &&
            command.type === "project.workflow.upsert" &&
            command.workflow.implementation?.status === "implementing"
          ) {
            failPostDispatchUpsert = false;
            return new Error("injected post-dispatch workflow upsert failure");
          }
          return null;
        },
      },
    );

    await expect(
      Effect.runPromise(
        harness.service.startImplementation({
          workflowId: workflow.id,
          provider: "codex",
          model: "gpt-5-codex",
        }),
      ),
    ).rejects.toThrow("post-dispatch workflow upsert failure");

    const implementationThreadId =
      harness.getSnapshot().planningWorkflows[0]?.implementation?.threadId;
    expect(implementationThreadId).not.toBeNull();
    expect(turnStartsForThread(harness.dispatched, implementationThreadId!)).toHaveLength(1);

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));
    expect(turnStartsForThread(harness.dispatched, implementationThreadId!)).toHaveLength(1);
    expect(harness.getSnapshot().planningWorkflows[0]?.implementation?.status).toBe("implementing");
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

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("authoring");
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

  it("starts implementation from a newer unimplemented merge plan when approval re-pin is pending", async () => {
    const refinedAt = "2026-03-26T12:05:00.000Z";
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        approvedPlanId: "approved-plan",
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
                turnId: TurnId.makeUnsafe("merge-turn-approved"),
                planMarkdown: "# Approved plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: "refined-plan",
                turnId: TurnId.makeUnsafe("merge-turn-refined"),
                planMarkdown: "# Refined plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: refinedAt,
                updatedAt: refinedAt,
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

    const turnStart = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );
    const workflowUpsert = lastWorkflowUpsert(harness.dispatched);

    expect(turnStart?.sourceProposedPlan).toEqual({
      threadId: "merge-thread",
      planId: "refined-plan",
    });
    expect(turnStart?.message.text).toContain("# Refined plan");
    expect(turnStart?.message.text).not.toContain("# Approved plan");
    expect(workflowUpsert?.workflow.merge.approvedPlanId).toBe("refined-plan");
    expect(workflowUpsert?.workflow.merge.turnId).toBe("merge-turn-refined");
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
    expect(typeof createWorktreeArgs?.newBranch).toBe("string");
    expect(createWorktreeArgs?.path).toBe(
      join(
        "/tmp/f5-workflow/worktrees/project",
        createWorktreeArgs!.newBranch!.replace(/\//g, "-"),
      ),
    );

    const threadCreate = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
        command.type === "thread.create",
    );
    expect(threadCreate?.branch).toBe(createWorktreeArgs?.newBranch);
    expect(threadCreate?.worktreePath).toBe(createWorktreeArgs?.path);
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

  it("starts v2 code reviews at quiescence when a multi-repository workspace has no checkpoint", async () => {
    const implementationThreadId = ThreadId.makeUnsafe("implementation-thread");
    const implementationTurnId = TurnId.makeUnsafe("implementation-turn");
    const workflow = makeWorkflow({
      templateId: "builtin.planning.dual",
      templateVersion: 2,
      implementation: makeImplementation({
        threadId: implementationThreadId,
        implementationTurnId,
        status: "implemented",
      }),
    });
    const mergeThread = makeThread({
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
    });
    const implementationThread = (processingQuiescedAt: string | null) =>
      makeThread({
        id: implementationThreadId,
        latestTurn: {
          turnId: implementationTurnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          processingQuiescedAt,
          assistantMessageId: MessageId.makeUnsafe("assistant-implementation"),
        },
        session: {
          threadId: implementationThreadId,
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
            turnId: implementationTurnId,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        checkpoints: [],
      });

    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [mergeThread, implementationThread(null)],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-processing-quiesced", {
        threadId: implementationThreadId,
        turnId: TurnId.makeUnsafe("stale-implementation-turn"),
        processingQuiescedAt: NOW,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title.includes("Code Review"),
      ),
    ).toBe(false);

    harness.setSnapshot(
      makeReadModel({
        workflow,
        threads: [mergeThread, implementationThread(NOW)],
      }),
    );
    await harness.emit(
      makeEvent("thread.turn-processing-quiesced", {
        threadId: implementationThreadId,
        turnId: implementationTurnId,
        processingQuiescedAt: NOW,
      }),
    );

    await waitFor(() => {
      const reviewStarts = harness!.dispatched.filter(
        (command) =>
          command.type === "thread.turn.start" && command.threadId !== implementationThreadId,
      );
      return reviewStarts.length === 2;
    });

    const reviewStarts = harness.dispatched.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" && command.threadId !== implementationThreadId,
    );
    expect(reviewStarts).toHaveLength(2);
    expect(
      reviewStarts.every((command) => command.message.text.includes("nested Git repositories")),
    ).toBe(true);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.status).toBe(
      "code_reviews_requested",
    );
    expect(
      lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.reviewArtifact,
    ).toBeUndefined();
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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

  it.each(["session-then-diff", "diff-then-session"] as const)(
    "starts revisions once when review completion arrives as %s",
    async (triggerOrder) => {
      const reviewTurnId = TurnId.makeUnsafe("review-turn-b");
      const reviewThreadId = ThreadId.makeUnsafe("review-b");
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
              retryCount: 0,
              lastRetryAt: null,
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
              threadId: reviewThreadId,
              outputFilePath: null,
              status: "running",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
          status: "reviews_requested",
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
              id: reviewThreadId,
              latestTurn: {
                turnId: reviewTurnId,
                state: "completed",
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: NOW,
                assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
              },
              session: {
                threadId: reviewThreadId,
                status: "running",
                providerName: "claudeAgent",
                runtimeMode: "full-access",
                activeTurnId: reviewTurnId,
                lastError: null,
                updatedAt: NOW,
              },
              messages: [
                {
                  id: MessageId.makeUnsafe("assistant-review-b"),
                  role: "assistant",
                  text: "Finding B",
                  turnId: reviewTurnId,
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

      const emitReady = (occurredAt = NOW) =>
        harness!.emit(
          makeEvent(
            "thread.session-set",
            {
              threadId: reviewThreadId,
              session: {
                threadId: reviewThreadId,
                status: "ready",
                providerName: "claudeAgent",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: occurredAt,
              },
            },
            occurredAt,
          ),
        );
      const emitDiffCompleted = (occurredAt = NOW) =>
        harness!.emit(
          makeEvent(
            "thread.turn-diff-completed",
            {
              threadId: reviewThreadId,
              turnId: reviewTurnId,
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.makeUnsafe("checkpoint-review-b"),
              status: "ready",
              files: [],
              assistantMessageId: MessageId.makeUnsafe("assistant-review-b"),
              completedAt: occurredAt,
            },
            occurredAt,
          ),
        );

      if (triggerOrder === "session-then-diff") {
        await emitReady();
      } else {
        await emitDiffCompleted();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(
          turnStartsForThread(harness.dispatched, workflow.branchA.authorThreadId),
        ).toHaveLength(0);
        expect(
          turnStartsForThread(harness.dispatched, workflow.branchB.authorThreadId),
        ).toHaveLength(0);
        await emitReady();
      }

      await waitFor(
        () => harness!.getSnapshot().planningWorkflows[0]?.branchA.status === "revising",
      );
      const workflowUpdatedAt = harness.getSnapshot().planningWorkflows[0]?.updatedAt;

      const replayedAt = "2026-03-26T12:01:00.000Z";
      await emitDiffCompleted(replayedAt);
      await emitReady(replayedAt);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(turnStartsForThread(harness.dispatched, workflow.branchA.authorThreadId)).toHaveLength(
        1,
      );
      expect(turnStartsForThread(harness.dispatched, workflow.branchB.authorThreadId)).toHaveLength(
        1,
      );
      expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("revising");
      expect(harness.getSnapshot().planningWorkflows[0]?.branchB.status).toBe("revising");
      expect(harness.getSnapshot().planningWorkflows[0]?.updatedAt).toBe(workflowUpdatedAt);
      const revisionIntentIndex = harness.dispatched.findIndex(
        (command) =>
          command.type === "project.workflow.upsert" &&
          command.workflow.branchA.status === "revising" &&
          command.workflow.branchB.status === "revising",
      );
      const firstRevisionTurnIndex = harness.dispatched.findIndex(
        (command) =>
          command.type === "thread.turn.start" &&
          (command.threadId === workflow.branchA.authorThreadId ||
            command.threadId === workflow.branchB.authorThreadId),
      );
      expect(revisionIntentIndex).toBeGreaterThanOrEqual(0);
      expect(firstRevisionTurnIndex).toBeGreaterThan(revisionIntentIndex);
    },
  );

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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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

  it("does not start merge from a proposed revised plan until the revision turn finishes", async () => {
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const revisionTurnB = TurnId.makeUnsafe("revision-turn-b");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: revisionTurnA,
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
              turnId: revisionTurnA,
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
                turnId: revisionTurnA,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: revisionTurnA,
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
              turnId: revisionTurnB,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: revisionTurnB,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b"),
                role: "assistant",
                text: "Revised plan B",
                turnId: revisionTurnB,
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
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("author-b"),
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe("plan-b"),
          turnId: revisionTurnB,
          planMarkdown: "Revised plan B",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.status).toBe("revising");
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    ).toBe(false);

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-b"),
        session: {
          threadId: ThreadId.makeUnsafe("author-b"),
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
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revised");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.revisionTurnId).toBe(
      revisionTurnB,
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
  });

  it("does not complete a revising branch from the previous authoring turn", async () => {
    const oldPlanTurn = TurnId.makeUnsafe("plan-turn-b");
    const revisionStartedAt = "2026-03-26T12:01:00.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: TurnId.makeUnsafe("revision-turn-a"),
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: oldPlanTurn,
        revisionTurnId: null,
        status: "revising",
        updatedAt: revisionStartedAt,
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
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
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
              turnId: oldPlanTurn,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b-old"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: revisionStartedAt,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-old"),
                turnId: oldPlanTurn,
                planMarkdown: "Original plan B",
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
      makeEvent(
        "thread.session-set",
        {
          threadId: ThreadId.makeUnsafe("author-b"),
          session: {
            threadId: ThreadId.makeUnsafe("author-b"),
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: revisionStartedAt,
          },
        },
        revisionStartedAt,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.status).toBe("revising");
    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.revisionTurnId).toBeNull();
    expect(
      harness.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    ).toBe(false);
  });

  it("advances a revising branch from a completed turn when its plan was already captured", async () => {
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const revisionTurnB = TurnId.makeUnsafe("revision-turn-b");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: revisionTurnA,
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
              turnId: revisionTurnA,
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
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: revisionTurnA,
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
              turnId: revisionTurnB,
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
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
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b"),
                turnId: revisionTurnB,
                planMarkdown: "Revised plan B",
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
        threadId: ThreadId.makeUnsafe("author-b"),
        turnId: revisionTurnB,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-revision-b"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
        completedAt: NOW,
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revised");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.revisionTurnId).toBe(
      revisionTurnB,
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
  });

  it("repairs stale revised branch turn ids during reconciliation and starts merge", async () => {
    const planTurnA = TurnId.makeUnsafe("plan-turn-a");
    const planTurnB = TurnId.makeUnsafe("plan-turn-b");
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const revisionTurnB = TurnId.makeUnsafe("revision-turn-b");
    const revisionStartedAt = "2026-03-26T12:00:30.000Z";
    const revisionRequestedAt = "2026-03-26T12:01:00.000Z";
    const workflow = makeWorkflow({
      templateId: "builtin.planning.dual",
      templateVersion: 2,
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: planTurnA,
        revisionTurnId: planTurnA,
        status: "revised",
        updatedAt: revisionStartedAt,
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: planTurnB,
        revisionTurnId: planTurnB,
        status: "revised",
        updatedAt: revisionStartedAt,
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
              turnId: revisionTurnA,
              state: "completed",
              requestedAt: revisionRequestedAt,
              startedAt: revisionRequestedAt,
              completedAt: revisionRequestedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: revisionRequestedAt,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-a"),
                role: "assistant",
                text: "<proposed_plan>\nRevised plan A\n</proposed_plan>",
                turnId: revisionTurnA,
                streaming: false,
                createdAt: revisionRequestedAt,
                updatedAt: revisionRequestedAt,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a-revision"),
                turnId: revisionTurnA,
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: revisionRequestedAt,
                updatedAt: revisionRequestedAt,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: revisionTurnB,
              state: "completed",
              requestedAt: revisionRequestedAt,
              startedAt: revisionRequestedAt,
              completedAt: revisionRequestedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-b"),
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: revisionRequestedAt,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b"),
                role: "assistant",
                text: "Revised plan B",
                turnId: revisionTurnB,
                streaming: false,
                createdAt: revisionRequestedAt,
                updatedAt: revisionRequestedAt,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-revision"),
                turnId: revisionTurnB,
                planMarkdown: "Revised plan B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: revisionRequestedAt,
                updatedAt: revisionRequestedAt,
              },
            ],
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    const finalWorkflow = lastWorkflowUpsert(harness.dispatched)?.workflow;
    expect(finalWorkflow?.branchA.revisionTurnId).toBe(revisionTurnA);
    expect(finalWorkflow?.branchB.revisionTurnId).toBe(revisionTurnB);
    expect(finalWorkflow?.merge.status).toBe("in_progress");
    const mergeIntentIndex = harness.dispatched.findIndex(
      (command) =>
        command.type === "project.workflow.upsert" &&
        command.workflow.merge.status === "in_progress",
    );
    const mergeThreadCreateIndex = harness.dispatched.findIndex(
      (command) => command.type === "thread.create" && command.title === "Merge",
    );
    expect(mergeIntentIndex).toBeGreaterThanOrEqual(0);
    expect(mergeThreadCreateIndex).toBeGreaterThan(mergeIntentIndex);
    const synthesizedCapture = harness.dispatched.find(
      (command) =>
        command.type === "thread.proposed-plan.upsert" &&
        command.threadId === ThreadId.makeUnsafe("author-b") &&
        command.proposedPlan.turnId === revisionTurnB,
    );
    expect(synthesizedCapture).toBeUndefined();
  });

  it("repins a preliminary revision to the latest completed plan during startup reconciliation", async () => {
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const preliminaryTurnB = TurnId.makeUnsafe("revision-turn-b-preliminary");
    const finalTurnB = TurnId.makeUnsafe("revision-turn-b-final");
    const preliminaryCompletedAt = "2026-03-26T12:01:00.000Z";
    const finalRequestedAt = "2026-03-26T12:02:00.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: revisionTurnA,
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: preliminaryTurnB,
        status: "revised",
        updatedAt: preliminaryCompletedAt,
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
            id: workflow.branchA.authorThreadId,
            latestTurn: {
              turnId: revisionTurnA,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: workflow.branchA.authorThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: revisionTurnA,
                planMarkdown: "FINAL_REVISED_PLAN_A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.branchB.authorThreadId,
            latestTurn: {
              turnId: finalTurnB,
              state: "completed",
              requestedAt: finalRequestedAt,
              startedAt: finalRequestedAt,
              completedAt: finalRequestedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b-final"),
            },
            session: {
              threadId: workflow.branchB.authorThreadId,
              status: "ready",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: finalRequestedAt,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-preliminary"),
                turnId: preliminaryTurnB,
                planMarkdown: "PRELIMINARY_PREAMBLE_B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: preliminaryCompletedAt,
                updatedAt: preliminaryCompletedAt,
              },
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-final"),
                turnId: finalTurnB,
                planMarkdown: "FINAL_REVISED_PLAN_B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: finalRequestedAt,
                updatedAt: finalRequestedAt,
              },
            ],
          }),
        ],
      }),
    );

    await harness.start();

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    const repinnedWorkflow = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "project.workflow.upsert" }> =>
        command.type === "project.workflow.upsert" &&
        command.workflow.branchB.revisionTurnId === finalTurnB,
    )?.workflow;
    const mergeTurn = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.message.text.includes("FINAL_REVISED_PLAN_B"),
    );

    expect(repinnedWorkflow?.merge.status).toBe("not_started");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.revisionTurnId).toBe(
      finalTurnB,
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
    expect(mergeTurn?.message.text).toContain("FINAL_REVISED_PLAN_A");
    expect(mergeTurn?.message.text).not.toContain("PRELIMINARY_PREAMBLE_B");
  });

  it("repins a newer revision after its live turn finishes and then starts merge", async () => {
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const preliminaryTurnB = TurnId.makeUnsafe("revision-turn-b-preliminary");
    const finalTurnB = TurnId.makeUnsafe("revision-turn-b-final");
    const preliminaryCompletedAt = "2026-03-26T12:01:00.000Z";
    const finalRequestedAt = "2026-03-26T12:02:00.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: revisionTurnA,
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: preliminaryTurnB,
        status: "revised",
        updatedAt: preliminaryCompletedAt,
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
            id: workflow.branchA.authorThreadId,
            latestTurn: {
              turnId: revisionTurnA,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
            },
            session: {
              threadId: workflow.branchA.authorThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: revisionTurnA,
                planMarkdown: "FINAL_REVISED_PLAN_A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: workflow.branchB.authorThreadId,
            latestTurn: {
              turnId: finalTurnB,
              state: "running",
              requestedAt: finalRequestedAt,
              startedAt: finalRequestedAt,
              completedAt: null,
              assistantMessageId: MessageId.makeUnsafe("assistant-author-b-final"),
            },
            session: {
              threadId: workflow.branchB.authorThreadId,
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: finalTurnB,
              lastError: null,
              updatedAt: finalRequestedAt,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-author-b-final"),
                role: "assistant",
                text: "FINAL_REVISED_PLAN_B",
                turnId: finalTurnB,
                streaming: false,
                createdAt: finalRequestedAt,
                updatedAt: finalRequestedAt,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-preliminary"),
                turnId: preliminaryTurnB,
                planMarkdown: "PRELIMINARY_PREAMBLE_B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: preliminaryCompletedAt,
                updatedAt: preliminaryCompletedAt,
              },
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-final"),
                turnId: finalTurnB,
                planMarkdown: "FINAL_REVISED_PLAN_B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: finalRequestedAt,
                updatedAt: finalRequestedAt,
              },
            ],
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.turn-diff-completed", {
        threadId: workflow.branchB.authorThreadId,
        turnId: finalTurnB,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-author-b-final"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-author-b-final"),
        completedAt: finalRequestedAt,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.revisionTurnId).toBe(
      preliminaryTurnB,
    );

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: workflow.branchB.authorThreadId,
        session: {
          threadId: workflow.branchB.authorThreadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: finalRequestedAt,
        },
      }),
    );

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.revisionTurnId).toBe(
      finalTurnB,
    );
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.status).toBe("in_progress");
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.turn.start" &&
          command.message.text.includes("FINAL_REVISED_PLAN_B") &&
          !command.message.text.includes("PRELIMINARY_PREAMBLE_B"),
      ),
    ).toBe(true);
  });

  it.each([
    { name: "newer turn is still running", latestState: "running", hasPlan: true },
    {
      name: "newer turn predates the pinned revision",
      latestState: "completed",
      hasPlan: true,
      latestRequestedAt: "2026-03-26T12:00:00.000Z",
    },
    {
      name: "newer turn shares the pinned revision timestamp",
      latestState: "completed",
      hasPlan: true,
      latestRequestedAt: "2026-03-26T12:01:00.000Z",
    },
    { name: "newer turn has no consumable plan", latestState: "completed", hasPlan: false },
    {
      name: "merge has already started",
      latestState: "completed",
      hasPlan: true,
      mergeStatus: "in_progress",
    },
    {
      name: "workflow is archived",
      latestState: "completed",
      hasPlan: true,
      archivedAt: "2026-03-26T12:03:00.000Z",
    },
    {
      name: "workflow is deleted",
      latestState: "completed",
      hasPlan: true,
      deletedAt: "2026-03-26T12:03:00.000Z",
    },
  ] as const)(
    "does not repin a revised branch when $name",
    async ({ latestState, hasPlan, latestRequestedAt, mergeStatus, archivedAt, deletedAt }) => {
      const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
      const pinnedTurnB = TurnId.makeUnsafe("revision-turn-b-pinned");
      const newerTurnB = TurnId.makeUnsafe("revision-turn-b-newer");
      const branchUpdatedAt = "2026-03-26T12:01:00.000Z";
      const requestedAt = latestRequestedAt ?? "2026-03-26T12:02:00.000Z";
      const resolvedMergeStatus = mergeStatus ?? "not_started";
      const workflow = makeWorkflow({
        branchA: {
          ...makeWorkflow().branchA,
          revisionTurnId: revisionTurnA,
          status: "revised",
        },
        branchB: {
          ...makeWorkflow().branchB,
          revisionTurnId: pinnedTurnB,
          status: "revised",
          updatedAt: branchUpdatedAt,
        },
        merge: {
          ...makeWorkflow().merge,
          threadId:
            resolvedMergeStatus === "not_started"
              ? null
              : ThreadId.makeUnsafe("merge-thread-running"),
          outputFilePath: null,
          turnId: null,
          approvedPlanId: null,
          status: resolvedMergeStatus,
        },
        archivedAt: archivedAt ?? null,
        deletedAt: deletedAt ?? null,
      });
      harness = await createHarness(
        makeReadModel({
          workflow,
          threads: [
            makeThread({
              id: workflow.branchA.authorThreadId,
              latestTurn: {
                turnId: revisionTurnA,
                state: "completed",
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: NOW,
                assistantMessageId: MessageId.makeUnsafe("assistant-author-a"),
              },
              session: {
                threadId: workflow.branchA.authorThreadId,
                status: "ready",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
              proposedPlans: [
                {
                  id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                  turnId: revisionTurnA,
                  planMarkdown: "FINAL_REVISED_PLAN_A",
                  implementedAt: null,
                  implementationThreadId: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            }),
            makeThread({
              id: workflow.branchB.authorThreadId,
              latestTurn: {
                turnId: newerTurnB,
                state: latestState,
                requestedAt,
                startedAt: requestedAt,
                completedAt: latestState === "completed" ? requestedAt : null,
                assistantMessageId: hasPlan
                  ? MessageId.makeUnsafe("assistant-author-b-newer")
                  : null,
              },
              session: {
                threadId: workflow.branchB.authorThreadId,
                status: latestState === "completed" ? "ready" : "running",
                providerName: "claudeAgent",
                runtimeMode: "full-access",
                activeTurnId: latestState === "completed" ? null : newerTurnB,
                lastError: null,
                updatedAt: requestedAt,
              },
              proposedPlans: hasPlan
                ? [
                    {
                      id: OrchestrationProposedPlanId.makeUnsafe("plan-b-newer"),
                      turnId: newerTurnB,
                      planMarkdown: "NEWER_REVISED_PLAN_B",
                      implementedAt: null,
                      implementationThreadId: null,
                      createdAt: requestedAt,
                      updatedAt: requestedAt,
                    },
                  ]
                : [],
            }),
            ...(resolvedMergeStatus === "in_progress"
              ? [
                  makeThread({
                    id: ThreadId.makeUnsafe("merge-thread-running"),
                    session: {
                      threadId: ThreadId.makeUnsafe("merge-thread-running"),
                      status: "running",
                      providerName: "codex",
                      runtimeMode: "full-access",
                      activeTurnId: TurnId.makeUnsafe("merge-turn-running"),
                      lastError: null,
                      updatedAt: requestedAt,
                    },
                  }),
                ]
              : []),
          ],
        }),
      );

      await harness.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harness.getSnapshot().planningWorkflows[0]?.branchB.revisionTurnId).toBe(pinnedTurnB);
      expect(
        harness.dispatched.some(
          (command) =>
            command.type === "project.workflow.upsert" &&
            command.workflow.branchB.revisionTurnId === newerTurnB,
        ),
      ).toBe(false);
      expect(
        harness.dispatched.some(
          (command) => command.type === "thread.create" && command.title === "Merge",
        ),
      ).toBe(false);
    },
  );

  it("starts merge with the proposed plans that match each recorded revision turn", async () => {
    const revisionTurnA = TurnId.makeUnsafe("revision-turn-a");
    const revisionTurnB = TurnId.makeUnsafe("revision-turn-b");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        revisionTurnId: revisionTurnA,
        status: "revised",
      },
      branchB: {
        ...makeWorkflow().branchB,
        revisionTurnId: revisionTurnB,
        status: "revised",
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
              turnId: revisionTurnA,
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
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: revisionTurnA,
                planMarkdown: "Revised plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a-stale"),
                turnId: TurnId.makeUnsafe("stale-turn-a"),
                planMarkdown: "Stale later plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-03-26T12:00:01.000Z",
                updatedAt: "2026-03-26T12:00:01.000Z",
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: revisionTurnB,
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
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b"),
                turnId: revisionTurnB,
                planMarkdown: "Revised plan B",
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

    await waitFor(() =>
      harness!.dispatched.some(
        (command) => command.type === "thread.create" && command.title === "Merge",
      ),
    );

    const mergeTurnStart = harness.dispatched.find(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start" &&
        command.message.text.includes(
          "You have two independently authored and reviewed implementation plans",
        ),
    );
    expect(mergeTurnStart?.message.text).toContain("Revised plan A");
    expect(mergeTurnStart?.message.text).not.toContain("Stale later plan A");
    expect(mergeTurnStart?.message.text).toContain("Revised plan B");
  });

  it("does not mark merge ready for manual review until the merge turn finishes", async () => {
    const mergeTurnId = TurnId.makeUnsafe("merge-turn");
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        threadId: ThreadId.makeUnsafe("merge-thread"),
        outputFilePath: null,
        turnId: null,
        approvedPlanId: null,
        status: "in_progress",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            latestTurn: {
              turnId: mergeTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("assistant-merge"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("merge-thread"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: mergeTurnId,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-merge"),
                role: "assistant",
                text: "Merged plan",
                turnId: mergeTurnId,
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
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("merge-thread"),
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe("merged-plan"),
          turnId: mergeTurnId,
          planMarkdown: "Merged plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.getSnapshot().planningWorkflows[0]?.merge.status).toBe("in_progress");

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("merge-thread"),
        session: {
          threadId: ThreadId.makeUnsafe("merge-thread"),
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
      () => lastWorkflowUpsert(harness!.dispatched)?.workflow.merge.status === "manual_review",
    );

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.turnId).toBe(mergeTurnId);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.merge.approvedPlanId).toBe(
      "merged-plan",
    );
  });

  it("re-pins the approved merged plan when the manual-review merge chat is refined", async () => {
    const refineTurnId = TurnId.makeUnsafe("merge-refine-turn");
    const refinedAt = "2026-03-26T12:05:00.000Z";
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        turnId: "old-merge-turn",
        approvedPlanId: "old-plan",
        status: "manual_review",
      },
      implementation: null,
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            interactionMode: "plan",
            latestTurn: {
              turnId: refineTurnId,
              state: "completed",
              requestedAt: refinedAt,
              startedAt: refinedAt,
              completedAt: refinedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-refine"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("merge-thread"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: refinedAt,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("old-plan"),
                turnId: TurnId.makeUnsafe("old-merge-turn"),
                planMarkdown: "# Old merged plan",
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
      makeEvent(
        "thread.proposed-plan-upserted",
        {
          threadId: ThreadId.makeUnsafe("merge-thread"),
          proposedPlan: {
            id: OrchestrationProposedPlanId.makeUnsafe("refined-plan"),
            turnId: refineTurnId,
            planMarkdown: "# Refined merged plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: refinedAt,
            updatedAt: refinedAt,
          },
        },
        refinedAt,
      ),
    );

    await waitFor(
      () =>
        lastWorkflowUpsert(harness!.dispatched)?.workflow.merge.approvedPlanId === "refined-plan",
    );

    const workflowUpsert = lastWorkflowUpsert(harness.dispatched);
    expect(workflowUpsert?.workflow.merge.turnId).toBe(refineTurnId);
    expect(workflowUpsert?.workflow.merge.updatedAt).toBe(refinedAt);
    expect(workflowUpsert?.workflow.updatedAt).toBe(refinedAt);
  });

  it("does not re-pin manual-review merge plans after implementation has started", async () => {
    const refineTurnId = TurnId.makeUnsafe("merge-refine-turn");
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        approvedPlanId: "old-plan",
        status: "manual_review",
      },
      implementation: makeImplementation(),
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            interactionMode: "plan",
          }),
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
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.proposed-plan-upserted", {
        threadId: ThreadId.makeUnsafe("merge-thread"),
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe("refined-plan"),
          turnId: refineTurnId,
          planMarkdown: "# Refined merged plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lastWorkflowUpsert(harness.dispatched)).toBeNull();
    expect(harness.getSnapshot().planningWorkflows[0]?.merge.approvedPlanId).toBe("old-plan");
  });

  it("does not re-pin manual-review merge plans from implemented source-plan upserts", async () => {
    const implementedAt = "2026-03-26T12:06:00.000Z";
    const workflow = makeWorkflow({
      merge: {
        ...makeWorkflow().merge,
        approvedPlanId: "old-plan",
        status: "manual_review",
      },
      implementation: null,
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: ThreadId.makeUnsafe("merge-thread"),
            interactionMode: "plan",
          }),
        ],
      }),
    );
    await harness.start();

    await harness.emit(
      makeEvent(
        "thread.proposed-plan-upserted",
        {
          threadId: ThreadId.makeUnsafe("merge-thread"),
          proposedPlan: {
            id: OrchestrationProposedPlanId.makeUnsafe("implemented-plan"),
            turnId: TurnId.makeUnsafe("merge-turn"),
            planMarkdown: "# Implemented merged plan",
            implementedAt,
            implementationThreadId: ThreadId.makeUnsafe("implementation-thread"),
            createdAt: NOW,
            updatedAt: implementedAt,
          },
        },
        implementedAt,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lastWorkflowUpsert(harness.dispatched)).toBeNull();
    expect(harness.getSnapshot().planningWorkflows[0]?.merge.approvedPlanId).toBe("old-plan");
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

  it("accepts ordinary assistant text from v2 planning turns without format repair", async () => {
    const turnId = TurnId.makeUnsafe("natural-plan-turn");
    const workflow = makeWorkflow({
      templateId: "builtin.planning.dual",
      templateVersion: 2,
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
            id: workflow.branchA.authorThreadId,
            latestTurn: {
              turnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe(`assistant-${turnId}`),
            },
            session: {
              threadId: workflow.branchA.authorThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe(`assistant-${turnId}`),
                role: "assistant",
                text: "A naturally structured implementation plan",
                turnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
            proposedPlans: [],
          }),
        ],
      }),
    );
    await harness.start();

    await waitFor(
      () => harness!.getSnapshot().planningWorkflows[0]?.branchA.status === "plan_saved",
    );
    expect(
      harness.dispatched.some(
        (command) =>
          command.type === "thread.proposed-plan.upsert" &&
          command.proposedPlan.planMarkdown === "A naturally structured implementation plan",
      ),
    ).toBe(true);
    expect(turnStartsForThread(harness.dispatched, workflow.branchA.authorThreadId)).toHaveLength(
      0,
    );
    expect(
      harness.getSnapshot().planningWorkflows[0]?.branchA.authorFormatRepairAttempts ?? 0,
    ).toBe(0);
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
            retryCount: 0,
            lastRetryAt: null,
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
            retryCount: 0,
            lastRetryAt: null,
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

  it("re-pins a plan-saved branch to a later proposed plan before reviews start", async () => {
    const statusTurnId = TurnId.makeUnsafe("status-turn-a");
    const finalTurnId = TurnId.makeUnsafe("final-turn-a");
    const planTurnIdB = TurnId.makeUnsafe("plan-turn-b");
    const statusAt = "2026-03-26T12:00:00.000Z";
    const finalAt = "2026-03-26T12:02:00.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: statusTurnId,
        status: "plan_saved",
        updatedAt: statusAt,
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: planTurnIdB,
        status: "plan_saved",
        updatedAt: statusAt,
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
              turnId: finalTurnId,
              state: "completed",
              requestedAt: finalAt,
              startedAt: finalAt,
              completedAt: finalAt,
              processingQuiescedAt: null,
              assistantMessageId: MessageId.makeUnsafe("assistant-final-a"),
            },
            session: {
              threadId: ThreadId.makeUnsafe("author-a"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: finalAt,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("assistant-status-a"),
                role: "assistant",
                text: "STATUS_ONLY_DO_NOT_REVIEW",
                turnId: statusTurnId,
                streaming: false,
                createdAt: statusAt,
                updatedAt: statusAt,
              },
              {
                id: MessageId.makeUnsafe("assistant-final-a"),
                role: "assistant",
                text: "FINAL_PLAN_A_FOR_REVIEW",
                turnId: finalTurnId,
                streaming: false,
                createdAt: finalAt,
                updatedAt: finalAt,
              },
            ],
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("status-plan-a"),
                turnId: statusTurnId,
                planMarkdown: "STATUS_ONLY_DO_NOT_REVIEW",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: statusAt,
                updatedAt: statusAt,
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

    await harness.emit(
      makeEvent(
        "thread.proposed-plan-upserted",
        {
          threadId: ThreadId.makeUnsafe("author-a"),
          proposedPlan: {
            id: OrchestrationProposedPlanId.makeUnsafe("final-plan-a"),
            turnId: finalTurnId,
            planMarkdown: "FINAL_PLAN_A_FOR_REVIEW",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: finalAt,
            updatedAt: finalAt,
          },
        },
        finalAt,
      ),
    );
    await harness.emit(
      makeEvent(
        "thread.turn-processing-quiesced",
        {
          threadId: ThreadId.makeUnsafe("author-a"),
          turnId: finalTurnId,
          processingQuiescedAt: finalAt,
        },
        finalAt,
      ),
    );

    await waitFor(
      () =>
        lastWorkflowUpsert(harness!.dispatched)?.workflow.branchA.status === "reviews_requested",
    );

    const finalWorkflow = lastWorkflowUpsert(harness.dispatched)?.workflow;
    expect(finalWorkflow?.branchA.planTurnId).toBe(finalTurnId);
    expect(finalWorkflow?.branchB.status).toBe("reviews_requested");

    const reviewPrompts = harness.dispatched
      .filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      )
      .map((command) => command.message.text);
    expect(reviewPrompts.some((prompt) => prompt.includes("FINAL_PLAN_A_FOR_REVIEW"))).toBe(true);
    expect(reviewPrompts.some((prompt) => prompt.includes("STATUS_ONLY_DO_NOT_REVIEW"))).toBe(
      false,
    );
  });

  it("does not re-pin a plan-saved branch after reviews have started", async () => {
    await expectPlanSavedBranchRepinSkipped({
      reviews: [
        {
          slot: "cross",
          threadId: ThreadId.makeUnsafe("review-a"),
          outputFilePath: null,
          status: "running",
          error: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: NOW,
        },
      ],
    });
  });

  it("does not re-pin a plan-saved branch after merge has started", async () => {
    await expectPlanSavedBranchRepinSkipped({
      mergeStatus: "in_progress",
    });
  });

  it("does not re-pin a plan-saved branch to a later turn without a proposed plan", async () => {
    await expectPlanSavedBranchRepinSkipped({
      trigger: "message-sent",
    });
  });

  it("starts reviews from pinned plans after a newer no-plan follow-up quiesces", async () => {
    const planTurnIdA = TurnId.makeUnsafe("plan-turn-a");
    const planTurnIdB = TurnId.makeUnsafe("plan-turn-b");
    const followUpTurnIdB = TurnId.makeUnsafe("follow-up-turn-b");
    const savedAt = "2026-08-31T17:01:57.000Z";
    const followUpAt = "2026-08-31T17:08:41.000Z";
    const quiescedAt = "2026-08-31T17:12:19.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "plan_saved",
        planTurnId: planTurnIdA,
        revisionTurnId: null,
        updatedAt: savedAt,
      },
      branchB: {
        ...makeWorkflow().branchB,
        status: "plan_saved",
        planTurnId: planTurnIdB,
        revisionTurnId: null,
        updatedAt: savedAt,
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
              turnId: planTurnIdA,
              state: "completed",
              requestedAt: savedAt,
              startedAt: savedAt,
              completedAt: savedAt,
              processingQuiescedAt: savedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-plan-a"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: planTurnIdA,
                planMarkdown: "PINNED_PLAN_A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: followUpTurnIdB,
              state: "completed",
              requestedAt: followUpAt,
              startedAt: followUpAt,
              completedAt: quiescedAt,
              processingQuiescedAt: quiescedAt,
              assistantMessageId: MessageId.makeUnsafe("assistant-follow-up-b"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b"),
                turnId: planTurnIdB,
                planMarkdown: "PINNED_PLAN_B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
            ],
          }),
        ],
      }),
    );

    await harness.start();
    await waitFor(
      () => harness!.getSnapshot().planningWorkflows[0]?.branchA.status === "reviews_requested",
    );

    const finalWorkflow = harness.getSnapshot().planningWorkflows[0];
    expect(finalWorkflow?.branchA.planTurnId).toBe(planTurnIdA);
    expect(finalWorkflow?.branchB.planTurnId).toBe(planTurnIdB);
    expect(finalWorkflow?.branchB.status).toBe("reviews_requested");
    const reviewPrompts = harness.dispatched
      .filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      )
      .map((command) => command.message.text);
    expect(reviewPrompts).toHaveLength(4);
    expect(reviewPrompts.some((prompt) => prompt.includes("PINNED_PLAN_A"))).toBe(true);
    expect(reviewPrompts.some((prompt) => prompt.includes("PINNED_PLAN_B"))).toBe(true);
  });

  it("waits for a newer no-plan follow-up to quiesce before starting reviews", async () => {
    const planTurnIdA = TurnId.makeUnsafe("plan-turn-a-waiting");
    const planTurnIdB = TurnId.makeUnsafe("plan-turn-b-waiting");
    const followUpTurnIdB = TurnId.makeUnsafe("follow-up-turn-b-waiting");
    const savedAt = "2026-08-31T17:01:57.000Z";
    const completedAt = "2026-08-31T17:12:18.000Z";
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "plan_saved",
        planTurnId: planTurnIdA,
        revisionTurnId: null,
        updatedAt: savedAt,
      },
      branchB: {
        ...makeWorkflow().branchB,
        status: "plan_saved",
        planTurnId: planTurnIdB,
        revisionTurnId: null,
        updatedAt: savedAt,
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
              turnId: planTurnIdA,
              state: "completed",
              requestedAt: savedAt,
              startedAt: savedAt,
              completedAt: savedAt,
              processingQuiescedAt: savedAt,
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a-waiting"),
                turnId: planTurnIdA,
                planMarkdown: "Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
            ],
          }),
          makeThread({
            id: ThreadId.makeUnsafe("author-b"),
            latestTurn: {
              turnId: followUpTurnIdB,
              state: "completed",
              requestedAt: "2026-08-31T17:08:41.000Z",
              startedAt: "2026-08-31T17:08:41.000Z",
              completedAt,
              processingQuiescedAt: null,
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-b-waiting"),
                turnId: planTurnIdB,
                planMarkdown: "Plan B",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: savedAt,
                updatedAt: savedAt,
              },
            ],
          }),
        ],
      }),
    );

    await harness.start();
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("plan_saved");

    const quiescedAt = "2026-08-31T17:12:19.000Z";
    await harness.emit(
      makeEvent(
        "thread.turn-processing-quiesced",
        {
          threadId: ThreadId.makeUnsafe("author-b"),
          turnId: followUpTurnIdB,
          processingQuiescedAt: quiescedAt,
        },
        quiescedAt,
      ),
    );
    await waitFor(
      () => harness!.getSnapshot().planningWorkflows[0]?.branchA.status === "reviews_requested",
    );
    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.planTurnId).toBe(planTurnIdB);
  });

  it("does not fail a plan-saved branch when a later author follow-up errors", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "plan_saved",
        planTurnId: TurnId.makeUnsafe("saved-plan-turn-a-error"),
      },
      branchB: {
        ...makeWorkflow().branchB,
        status: "authoring",
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
        threads: [makeThread({ id: ThreadId.makeUnsafe("author-a") })],
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
          activeTurnId: TurnId.makeUnsafe("failed-follow-up-turn-a"),
          lastError: "follow-up failed",
          updatedAt: NOW,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("plan_saved");
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.error).toBeNull();
  });

  it("does not re-pin a plan-saved branch from a stale completed turn", async () => {
    await expectPlanSavedBranchRepinSkipped({
      branchUpdatedAt: "2026-03-26T12:03:00.000Z",
      finalRequestedAt: "2026-03-26T12:02:00.000Z",
    });
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
    const reviewIntentIndex = harness.dispatched.findIndex(
      (command) =>
        command.type === "project.workflow.upsert" &&
        command.workflow.branchA.status === "reviews_requested" &&
        command.workflow.branchB.status === "reviews_requested",
    );
    const firstReviewThreadIndex = harness.dispatched.findIndex(
      (command) => command.type === "thread.create" && command.title.includes("Review"),
    );
    expect(reviewIntentIndex).toBeGreaterThanOrEqual(0);
    expect(firstReviewThreadIndex).toBeGreaterThan(reviewIntentIndex);
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

  it("revalidates a persisted Opus 5 slot after a CLI downgrade before an automatic retry", async () => {
    vi.useFakeTimers();
    let providers: ReadonlyArray<ServerProvider> = [
      claudeProvider(["claude-opus-5", "claude-fable-5"]),
    ];
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        authorSlot: {
          provider: "claudeAgent",
          model: "claude-opus-5",
          modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
        },
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
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
      { getProviders: () => providers },
    );
    await harness.start();

    providers = [claudeProvider(["claude-fable-5", "claude-opus-4-8"])];
    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("author-a"),
        session: {
          threadId: ThreadId.makeUnsafe("author-a"),
          status: "error",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "429 too many requests for api key pool",
          updatedAt: NOW,
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(5_001);
    const retry = turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a")).at(-1);
    expect(retry).toMatchObject({
      provider: "claudeAgent",
      model: "claude-fable-5",
    });
    expect(retry?.modelOptions).toBeUndefined();
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

  it("auto-retries a planning review only after an accepted turn definitively fails", async () => {
    vi.useFakeTimers();
    const reviewThreadId = ThreadId.makeUnsafe("review-a-cross");
    const planTurnId = TurnId.makeUnsafe("plan-a");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId,
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
      branchB: {
        ...makeWorkflow().branchB,
        status: "reviews_requested",
      },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
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
              assistantMessageId: MessageId.makeUnsafe("plan-a-message"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: planTurnId,
                planMarkdown: "# Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: reviewThreadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("review-turn-a"),
              state: "error",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
            session: {
              threadId: reviewThreadId,
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
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewThreadId,
        session: {
          threadId: reviewThreadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "WebSocket connection reset",
          updatedAt: NOW,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1);

    const retriedReview = lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.reviews[0];
    expect(retriedReview?.status).toBe("running");
    expect(retriedReview?.retryCount).toBe(1);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe(
      "reviews_requested",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnStartsForThread(harness.dispatched, reviewThreadId)).toHaveLength(1);
  });

  it("restores a planning review error when automatic retry dispatch fails", async () => {
    vi.useFakeTimers();
    const reviewThreadId = ThreadId.makeUnsafe("review-auto-retry-dispatch-failure");
    const planTurnId = TurnId.makeUnsafe("plan-auto-retry-dispatch-failure");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId,
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
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
              assistantMessageId: MessageId.makeUnsafe("plan-auto-retry-message"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-auto-retry"),
                turnId: planTurnId,
                planMarkdown: "# Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: reviewThreadId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("failed-review-turn"),
              state: "error",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
            session: {
              threadId: reviewThreadId,
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
      {
        dispatchDefect: (command) =>
          command.type === "thread.turn.start" && command.threadId === reviewThreadId
            ? new Error("provider dispatch unavailable")
            : null,
      },
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewThreadId,
        session: {
          threadId: reviewThreadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "WebSocket connection reset",
          updatedAt: NOW,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_001);

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]).toMatchObject({
      status: "error",
      retryCount: 1,
    });
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]?.error).toContain(
      "Automatic retry failed",
    );
  });

  it("does not auto-retry an ambiguous planning review thread/start delivery", async () => {
    vi.useFakeTimers();
    const reviewThreadId = ThreadId.makeUnsafe("review-a-cross");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
      branchB: { ...makeWorkflow().branchB, status: "reviews_requested" },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: reviewThreadId,
            latestTurn: null,
            session: {
              threadId: reviewThreadId,
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
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewThreadId,
        session: {
          threadId: reviewThreadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Timed out waiting for thread/start.",
          updatedAt: NOW,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_001);

    const failedReview = lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.reviews[0];
    expect(failedReview?.status).toBe("error");
    expect(failedReview?.error).toContain("Timed out waiting for thread/start.");
    expect(failedReview?.retryCount).toBe(0);
    expect(turnStartsForThread(harness.dispatched, reviewThreadId)).toHaveLength(0);
  });

  it("recovers a planning review when a newer successful completion arrives after error", async () => {
    const reviewThreadId = ThreadId.makeUnsafe("review-a-cross");
    const reviewTurnId = TurnId.makeUnsafe("review-turn-a");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "error",
            error: "connection reset",
            retryCount: 1,
            lastRetryAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
      branchB: { ...makeWorkflow().branchB, status: "reviews_requested" },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: reviewThreadId,
            latestTurn: {
              turnId: reviewTurnId,
              state: "error",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
            session: {
              threadId: reviewThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: reviewTurnId,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );
    await harness.start();
    harness.setSnapshot({
      ...harness.getSnapshot(),
      threads: harness.getSnapshot().threads.map((thread) =>
        thread.id === reviewThreadId
          ? {
              ...thread,
              latestTurn: {
                turnId: reviewTurnId,
                state: "completed" as const,
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: NOW,
                assistantMessageId: MessageId.makeUnsafe("review-answer"),
              },
              messages: [
                {
                  id: MessageId.makeUnsafe("review-answer"),
                  role: "assistant" as const,
                  text: "Looks good",
                  turnId: reviewTurnId,
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
              session: {
                ...thread.session!,
                status: "ready" as const,
                activeTurnId: null,
              },
            }
          : thread,
      ),
    });

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewThreadId,
        session: harness.getSnapshot().threads.find((thread) => thread.id === reviewThreadId)!
          .session!,
      }),
    );
    await waitFor(
      () =>
        lastWorkflowUpsert(harness!.dispatched)?.workflow.branchA.reviews[0]?.status ===
        "completed",
      100,
    );

    const recovered = lastWorkflowUpsert(harness.dispatched)?.workflow.branchA;
    expect(recovered?.reviews[0]?.status).toBe("completed");
    expect(recovered?.reviews[0]?.error).toBeNull();
    expect(recovered?.status).toBe("reviews_saved");
  });

  it("requires confirmation for ambiguous manual retry and reuses its durable delivery", async () => {
    const reviewThreadId = ThreadId.makeUnsafe("review-a-cross");
    const planTurnId = TurnId.makeUnsafe("plan-a");
    const ambiguous = makeProviderTurnDelivery(reviewThreadId, "ambiguous");
    const retryDelivery = vi.fn<ProviderTurnDeliveryWorkerShape["retry"]>(() =>
      Effect.succeed({ ...ambiguous, state: "pending" }),
    );
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId,
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "error",
            error: "Timed out waiting for thread/start.",
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
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
              assistantMessageId: MessageId.makeUnsafe("plan-a-message"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("plan-a"),
                turnId: planTurnId,
                planMarkdown: "# Plan A",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
      {
        recheckDelivery: () => Effect.succeed(ambiguous),
        retryDelivery,
      },
    );

    const firstResult = await Effect.runPromise(
      harness.service.retryWorkflow({ workflowId: workflow.id }),
    );
    expect(firstResult).toEqual({
      status: "confirmation_required",
      threadIds: [reviewThreadId],
    });
    expect(retryDelivery).not.toHaveBeenCalled();

    const confirmedResult = await Effect.runPromise(
      harness.service.retryWorkflow({
        workflowId: workflow.id,
        allowPossibleDuplicate: true,
      }),
    );
    expect(confirmedResult).toEqual({ status: "started" });
    expect(retryDelivery).toHaveBeenCalledWith({
      threadId: reviewThreadId,
      allowPossibleDuplicate: true,
    });
    expect(turnStartsForThread(harness.dispatched, reviewThreadId)).toHaveLength(0);
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]?.status).toBe("error");
  });

  it.each(["pending", "sending"] as const)(
    "keeps a review visibly retryable while its durable delivery is %s",
    async (deliveryState) => {
      const reviewThreadId = ThreadId.makeUnsafe(`review-${deliveryState}`);
      const workflow = makeWorkflow({
        branchA: {
          ...makeWorkflow().branchA,
          planTurnId: "plan-a",
          status: "reviews_requested",
          reviews: [
            {
              slot: "cross",
              threadId: reviewThreadId,
              outputFilePath: null,
              status: "error",
              error: "delivery failed",
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: NOW,
            },
          ],
        },
      });
      harness = await createHarness(makeReadModel({ workflow }), {
        recheckDelivery: () =>
          Effect.succeed(makeProviderTurnDelivery(reviewThreadId, deliveryState)),
      });

      expect(
        await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id })),
      ).toEqual({ status: "started" });
      expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]).toMatchObject({
        status: "error",
        error: "delivery failed",
      });
      expect(turnStartsForThread(harness.dispatched, reviewThreadId)).toHaveLength(0);
    },
  );

  it("reconciles a completed accepted delivery before advancing its review", async () => {
    const reviewThreadId = ThreadId.makeUnsafe("review-accepted-complete");
    const reviewTurnId = TurnId.makeUnsafe("review-accepted-turn");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "reviews_requested",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "error",
            error: "delivery outcome was unknown",
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: reviewThreadId,
            latestTurn: {
              turnId: reviewTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("accepted-review-message"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("accepted-review-message"),
                role: "assistant",
                text: "Accepted review completed",
                turnId: reviewTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
      {
        recheckDelivery: () => Effect.succeed(makeProviderTurnDelivery(reviewThreadId, "accepted")),
      },
    );

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("reviews_saved");
    expect(turnStartsForThread(harness.dispatched, reviewThreadId)).toHaveLength(0);
  });

  it("recovers completed accepted authoring instead of creating a duplicate turn", async () => {
    const authorThreadId = ThreadId.makeUnsafe("author-a");
    const acceptedTurnId = TurnId.makeUnsafe("accepted-author-turn");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "delivery outcome was unknown",
        errorStage: "authoring",
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: authorThreadId,
            latestTurn: {
              turnId: acceptedTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("accepted-author-message"),
            },
            proposedPlans: [
              {
                id: OrchestrationProposedPlanId.makeUnsafe("accepted-author-plan"),
                turnId: acceptedTurnId,
                planMarkdown: "# Accepted author plan",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
      {
        recheckDelivery: () => Effect.succeed(makeProviderTurnDelivery(authorThreadId, "accepted")),
      },
    );

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA).toMatchObject({
      status: "plan_saved",
      planTurnId: acceptedTurnId,
      error: null,
      errorStage: null,
    });
    expect(turnStartsForThread(harness.dispatched, authorThreadId)).toHaveLength(0);
  });

  it("persists accepted completion evidence even when another retry fails preflight", async () => {
    const acceptedReviewId = ThreadId.makeUnsafe("accepted-review-before-preflight-error");
    const missingPlanReviewId = ThreadId.makeUnsafe("missing-plan-review");
    const acceptedTurnId = TurnId.makeUnsafe("accepted-review-before-preflight-turn");
    const review = (threadId: ThreadId) => ({
      slot: "cross" as const,
      threadId,
      outputFilePath: null,
      status: "error" as const,
      error: "review failed",
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    });
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "reviews_requested",
        reviews: [review(acceptedReviewId)],
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: "plan-b",
        status: "reviews_requested",
        reviews: [review(missingPlanReviewId)],
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: acceptedReviewId,
            latestTurn: {
              turnId: acceptedTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("accepted-before-preflight-message"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("accepted-before-preflight-message"),
                role: "assistant",
                text: "Accepted feedback",
                turnId: acceptedTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
      {
        recheckDelivery: (threadId) =>
          Effect.succeed(
            threadId === acceptedReviewId
              ? makeProviderTurnDelivery(acceptedReviewId, "accepted")
              : null,
          ),
      },
    );

    const error = await Effect.runPromise(
      Effect.flip(harness.service.retryWorkflow({ workflowId: workflow.id })),
    );

    expect(error.message).toContain("Saved plan not found for Branch B");
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]?.status).toBe(
      "completed",
    );
    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.reviews[0]?.status).toBe("error");
  });

  it("surfaces a delivery-recheck failure without mutating the failed stage", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        errorStage: "authoring",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }), {
      recheckDelivery: () => Effect.fail(new Error("provider offline")),
    });

    const error = await Effect.runPromise(
      Effect.flip(harness.service.retryWorkflow({ workflowId: workflow.id })),
    );

    expect(error.message).toContain("Could not verify provider delivery");
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA).toMatchObject({
      status: "error",
      error: "authoring failed",
      errorStage: "authoring",
    });
  });

  it("preflights the workflow budget before changing retry state", async () => {
    const workflow = makeWorkflow({
      totalCostUsd: 1,
      maxCostUsd: 1,
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        errorStage: "authoring",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }));

    const error = await Effect.runPromise(
      Effect.flip(harness.service.retryWorkflow({ workflowId: workflow.id })),
    );

    expect(error.message).toContain("Workflow cost limit reached");
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("error");
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      0,
    );
  });

  it("applies the workflow budget to durable delivery retries", async () => {
    const authorThreadId = ThreadId.makeUnsafe("author-a");
    const retryDelivery = vi.fn<ProviderTurnDeliveryWorkerShape["retry"]>(() =>
      Effect.succeed(makeProviderTurnDelivery(authorThreadId, "pending")),
    );
    const workflow = makeWorkflow({
      totalCostUsd: 1,
      maxCostUsd: 1,
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        errorStage: "authoring",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }), {
      recheckDelivery: () => Effect.succeed(makeProviderTurnDelivery(authorThreadId, "rejected")),
      retryDelivery,
    });

    const error = await Effect.runPromise(
      Effect.flip(harness.service.retryWorkflow({ workflowId: workflow.id })),
    );

    expect(error.message).toContain("Workflow cost limit reached");
    expect(retryDelivery).not.toHaveBeenCalled();
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("error");
  });

  it("keeps a failed stage retryable when dispatch itself fails", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        errorStage: "authoring",
      },
    });
    harness = await createHarness(makeReadModel({ workflow }), {
      dispatchDefect: (command) =>
        command.type === "thread.turn.start" && command.threadId === workflow.branchA.authorThreadId
          ? new Error("dispatch unavailable")
          : null,
    });

    const exit = await Effect.runPromiseExit(
      harness.service.retryWorkflow({ workflowId: workflow.id }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA).toMatchObject({
      status: "error",
      error: "authoring failed",
      errorStage: "authoring",
    });
  });

  it("retries only a failed revision while preserving its plan, reviews, and sibling branch", async () => {
    const reviewThreadId = ThreadId.makeUnsafe("completed-review-a");
    const reviewTurnId = TurnId.makeUnsafe("completed-review-turn-a");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "error",
        error: "revision failed",
        errorStage: "revision",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: "plan-b",
        revisionTurnId: "revision-b",
        status: "revised",
      },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: reviewThreadId,
            latestTurn: {
              turnId: reviewTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("completed-review-message-a"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("completed-review-message-a"),
                role: "assistant",
                text: "Keep the completed review",
                turnId: reviewTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    const retried = lastWorkflowUpsert(harness.dispatched)?.workflow;
    expect(retried?.branchA.planTurnId).toBe("plan-a");
    expect(retried?.branchA.reviews[0]?.status).toBe("completed");
    expect(retried?.branchA.status).toBe("revising");
    expect(retried?.branchB.status).toBe("revised");
    expect(retried?.branchB.revisionTurnId).toBe("revision-b");
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      1,
    );
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-b"))).toHaveLength(
      0,
    );
  });

  it("retries revision with available feedback when a completed review has no text", async () => {
    const availableReviewId = ThreadId.makeUnsafe("available-revision-feedback");
    const emptyReviewId = ThreadId.makeUnsafe("empty-revision-feedback");
    const availableTurnId = TurnId.makeUnsafe("available-revision-feedback-turn");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "error",
        error: "revision failed",
        errorStage: "revision",
        reviews: [
          {
            slot: "self",
            threadId: emptyReviewId,
            outputFilePath: null,
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
          {
            slot: "cross",
            threadId: availableReviewId,
            outputFilePath: null,
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({ id: emptyReviewId }),
          makeThread({
            id: availableReviewId,
            latestTurn: {
              turnId: availableTurnId,
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("available-revision-feedback-message"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("available-revision-feedback-message"),
                role: "assistant",
                text: "Use the available feedback",
                turnId: availableTurnId,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
        ],
      }),
    );

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.status).toBe("revising");
    const revisionTurn = turnStartsForThread(
      harness.dispatched,
      workflow.branchA.authorThreadId,
    )[0];
    expect(revisionTurn?.message.text).toContain("Use the available feedback");
  });

  it("fails clearly when an errored implementation has no thread", async () => {
    const workflow = makeWorkflow({
      implementation: makeImplementation({
        threadId: null,
        status: "error",
        error: "implementation failed",
      }),
    });
    harness = await createHarness(makeReadModel({ workflow }));

    const error = await Effect.runPromise(
      Effect.flip(harness.service.retryWorkflow({ workflowId: workflow.id })),
    );

    expect(error.message).toBe("Implementation thread not found for retry.");
    expect(harness.getSnapshot().planningWorkflows[0]?.implementation?.status).toBe("error");
  });

  it("resets only retry counters for manually retried stages", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        status: "error",
        error: "authoring failed",
        errorStage: "authoring",
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

    await Effect.runPromise(harness.service.retryWorkflow({ workflowId: workflow.id }));

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.retryCount).toBe(0);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.lastRetryAt).toBeNull();
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.retryCount).toBe(2);
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.implementation?.lastRetryAt).toBe(NOW);
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
      "provider crashed | provider: codex",
    );
  });

  it("does not clear a sibling revision error when another branch review completes", async () => {
    const reviewAId = ThreadId.makeUnsafe("completed-review-a-before-revision-error");
    const reviewBId = ThreadId.makeUnsafe("completing-review-b");
    const review = (threadId: ThreadId, status: "completed" | "running") => ({
      slot: "cross" as const,
      threadId,
      outputFilePath: null,
      status,
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    });
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "error",
        error: "revision failed",
        errorStage: "revision",
        reviews: [review(reviewAId, "completed")],
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: "plan-b",
        status: "reviews_requested",
        reviews: [review(reviewBId, "running")],
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: reviewBId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("completed-review-b-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("completed-review-b-message"),
            },
            messages: [
              {
                id: MessageId.makeUnsafe("completed-review-b-message"),
                role: "assistant",
                text: "Review B complete",
                turnId: TurnId.makeUnsafe("completed-review-b-turn"),
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

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA).toMatchObject({
      status: "error",
      error: "revision failed",
      errorStage: "revision",
      updatedAt: NOW,
    });
    expect(harness.getSnapshot().planningWorkflows[0]?.branchB.status).toBe("reviews_saved");
    expect(turnStartsForThread(harness.dispatched, workflow.branchA.authorThreadId)).toHaveLength(
      0,
    );
  });

  it("ignores stale review session errors after the branch was revised", async () => {
    const reviewThreadId = ThreadId.makeUnsafe("stale-review-error");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        revisionTurnId: "revision-a",
        status: "revised",
        reviews: [
          {
            slot: "cross",
            threadId: reviewThreadId,
            outputFilePath: null,
            status: "completed",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
    });
    harness = await createHarness(
      makeReadModel({ workflow, threads: [makeThread({ id: reviewThreadId })] }),
    );
    await harness.start();

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewThreadId,
        session: {
          threadId: reviewThreadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "late transport error",
          updatedAt: NOW,
        },
      }),
    );

    expect(harness.getSnapshot().planningWorkflows[0]?.branchA).toMatchObject({
      status: "revised",
      revisionTurnId: "revision-a",
      error: null,
      errorStage: null,
    });
    expect(harness.getSnapshot().planningWorkflows[0]?.branchA.reviews[0]).toMatchObject({
      status: "completed",
      error: null,
    });
  });

  it("partially heals legacy branch-level review errors and preserves the provider error", async () => {
    const completedReviewId = ThreadId.makeUnsafe("review-a-completed");
    const failedReviewId = ThreadId.makeUnsafe("review-a-failed");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "error",
        error: "legacy branch review failure",
        errorStage: null,
        reviews: [
          {
            slot: "cross",
            threadId: completedReviewId,
            outputFilePath: null,
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
          {
            slot: "self",
            threadId: failedReviewId,
            outputFilePath: null,
            status: "running",
            error: null,
            retryCount: 0,
            lastRetryAt: null,
            updatedAt: NOW,
          },
        ],
      },
    });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          makeThread({
            id: completedReviewId,
            latestTurn: {
              turnId: TurnId.makeUnsafe("completed-review-turn"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: MessageId.makeUnsafe("completed-review-message"),
            },
            session: {
              threadId: completedReviewId,
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
            messages: [
              {
                id: MessageId.makeUnsafe("completed-review-message"),
                role: "assistant",
                text: "Completed review",
                turnId: TurnId.makeUnsafe("completed-review-turn"),
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          }),
          makeThread({
            id: failedReviewId,
            session: {
              threadId: failedReviewId,
              status: "error",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "Timed out waiting for thread/start.",
              updatedAt: NOW,
            },
          }),
        ],
      }),
    );

    await harness.start();

    const repaired = lastWorkflowUpsert(harness.dispatched)?.workflow.branchA;
    expect(repaired?.status).toBe("reviews_requested");
    expect(repaired?.error).toBeNull();
    expect(repaired?.reviews.find((review) => review.threadId === completedReviewId)?.status).toBe(
      "completed",
    );
    expect(repaired?.reviews.find((review) => review.threadId === failedReviewId)).toMatchObject({
      status: "error",
      error: "Timed out waiting for thread/start. | provider: codex",
    });
  });

  it("restarts legacy review setup without discarding saved branch plans", async () => {
    const planATurnId = TurnId.makeUnsafe("legacy-plan-a-turn");
    const planBTurnId = TurnId.makeUnsafe("legacy-plan-b-turn");
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: planATurnId,
        status: "error",
        error: "review setup failed",
        errorStage: null,
        reviews: [],
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: planBTurnId,
        status: "error",
        error: "review setup failed",
        errorStage: null,
        reviews: [],
      },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
    });
    const planThread = (threadId: ThreadId, turnId: TurnId, suffix: string) =>
      makeThread({
        id: threadId,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: MessageId.makeUnsafe(`legacy-plan-${suffix}-message`),
        },
        proposedPlans: [
          {
            id: OrchestrationProposedPlanId.makeUnsafe(`legacy-plan-${suffix}`),
            turnId,
            planMarkdown: `# Plan ${suffix.toUpperCase()}`,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [
          planThread(workflow.branchA.authorThreadId, planATurnId, "a"),
          planThread(workflow.branchB.authorThreadId, planBTurnId, "b"),
        ],
      }),
    );

    await harness.start();

    const repaired = harness.getSnapshot().planningWorkflows[0];
    expect(repaired?.branchA.planTurnId).toBe(planATurnId);
    expect(repaired?.branchB.planTurnId).toBe(planBTurnId);
    expect(repaired?.branchA.status).toBe("reviews_requested");
    expect(repaired?.branchB.status).toBe("reviews_requested");
    expect(repaired?.branchA.reviews).toHaveLength(2);
    expect(repaired?.branchB.reviews).toHaveLength(2);
    expect(turnStartsForThread(harness.dispatched, workflow.branchA.authorThreadId)).toHaveLength(
      0,
    );
    expect(turnStartsForThread(harness.dispatched, workflow.branchB.authorThreadId)).toHaveLength(
      0,
    );
  });

  it("fully heals legacy review errors and starts each revision exactly once", async () => {
    const reviewAId = ThreadId.makeUnsafe("legacy-review-a");
    const reviewBId = ThreadId.makeUnsafe("legacy-review-b");
    const review = (threadId: ThreadId) => ({
      slot: "cross" as const,
      threadId,
      outputFilePath: null,
      status: "running" as const,
      error: null,
      retryCount: 0,
      lastRetryAt: null,
      updatedAt: NOW,
    });
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        planTurnId: "plan-a",
        status: "error",
        error: "legacy review failure A",
        errorStage: null,
        reviews: [review(reviewAId)],
      },
      branchB: {
        ...makeWorkflow().branchB,
        planTurnId: "plan-b",
        status: "error",
        error: "legacy review failure B",
        errorStage: null,
        reviews: [review(reviewBId)],
      },
      merge: { ...makeWorkflow().merge, threadId: null, status: "not_started" },
    });
    const completedReviewThread = (threadId: ThreadId, suffix: string) => {
      const turnId = TurnId.makeUnsafe(`legacy-review-turn-${suffix}`);
      const messageId = MessageId.makeUnsafe(`legacy-review-message-${suffix}`);
      return makeThread({
        id: threadId,
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: messageId,
        },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
        messages: [
          {
            id: messageId,
            role: "assistant",
            text: `Review ${suffix}`,
            turnId,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
    };
    harness = await createHarness(
      makeReadModel({
        workflow,
        threads: [completedReviewThread(reviewAId, "a"), completedReviewThread(reviewBId, "b")],
      }),
    );

    await harness.start();

    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchA.status).toBe("revising");
    expect(lastWorkflowUpsert(harness.dispatched)?.workflow.branchB.status).toBe("revising");
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      1,
    );
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-b"))).toHaveLength(
      1,
    );

    await harness.emit(
      makeEvent("thread.session-set", {
        threadId: reviewAId,
        session: harness.getSnapshot().threads.find((thread) => thread.id === reviewAId)!.session!,
      }),
    );
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))).toHaveLength(
      1,
    );
    expect(turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-b"))).toHaveLength(
      1,
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

  it("revalidates persisted Opus 5 slots during startup reconciliation", async () => {
    const workflow = makeWorkflow({
      branchA: {
        ...makeWorkflow().branchA,
        authorSlot: {
          provider: "claudeAgent",
          model: "claude-opus-5",
          modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
        },
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
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("author-turn"),
              lastError: null,
              updatedAt: NOW,
            },
          }),
        ],
      }),
      {
        getProviders: () => [claudeProvider(["claude-fable-5", "claude-opus-4-8"])],
      },
    );

    await harness.start();
    await waitFor(
      () => turnStartsForThread(harness!.dispatched, ThreadId.makeUnsafe("author-a")).length === 1,
      100,
    );

    const restarted = turnStartsForThread(harness.dispatched, ThreadId.makeUnsafe("author-a"))[0];
    expect(restarted).toMatchObject({
      provider: "claudeAgent",
      model: "claude-fable-5",
    });
    expect(restarted?.modelOptions).toBeUndefined();
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
