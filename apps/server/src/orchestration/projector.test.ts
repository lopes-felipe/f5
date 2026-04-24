import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        model: "gpt-5-codex",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: now,
        lastInteractionAt: now,
        updatedAt: now,
        deletedAt: null,
        estimatedContextTokens: null,
        modelContextWindowTokens: 200_000,
        messages: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        sessionNotes: null,
        threadReferences: [],
        activities: [],
        checkpoints: [],
        compaction: null,
        session: null,
      },
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              model: "gpt-5-codex",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");
  });

  it("keeps the latest turn running when a turn diff is refreshed before the turn completes", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const diffAt = "2026-02-23T08:00:06.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create-running-diff",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.4",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running-diff",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const afterCheckpoint = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeEvent({
          sequence: 3,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: diffAt,
          commandId: "cmd-running-diff-checkpoint",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
            assistantMessageId: "assistant-running-diff",
            completedAt: diffAt,
          },
        }),
      ),
    );

    expect(afterCheckpoint.threads[0]?.latestTurn).toEqual({
      turnId: "turn-1",
      state: "running",
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: "assistant-running-diff",
    });
    expect(afterCheckpoint.threads[0]?.checkpoints).toHaveLength(1);
  });

  it("projects session token usage snapshots onto the thread and preserves them across later session updates", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const usageAt = "2026-02-23T08:00:05.000Z";
    const readyAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.4",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUsage = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: usageAt,
          commandId: "cmd-usage",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              estimatedContextTokens: 45_000,
              tokenUsageSource: "provider",
              updatedAt: usageAt,
            },
          },
        }),
      ),
    );

    const afterReady = await Effect.runPromise(
      projectEvent(
        afterUsage,
        makeEvent({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: readyAt,
          commandId: "cmd-ready",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: readyAt,
            },
          },
        }),
      ),
    );

    expect(afterUsage.threads[0]?.estimatedContextTokens).toBe(45_000);
    expect(afterUsage.threads[0]?.session?.estimatedContextTokens).toBe(45_000);
    expect(afterReady.threads[0]?.estimatedContextTokens).toBe(45_000);
    expect(afterReady.threads[0]?.session?.estimatedContextTokens).toBe(45_000);
    expect(afterReady.threads[0]?.session?.tokenUsageSource).toBe("provider");
  });

  it("estimates context tokens locally from message traffic when the provider does not report usage", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const sessionAt = "2026-02-23T08:00:05.000Z";
    const messageAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.4",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterSession = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: sessionAt,
          commandId: "cmd-session",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: sessionAt,
            },
          },
        }),
      ),
    );

    const afterMessage = await Effect.runPromise(
      projectEvent(
        afterSession,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: messageAt,
          commandId: "cmd-message",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            role: "user",
            text: "Hello there",
            turnId: null,
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        }),
      ),
    );

    expect(afterMessage.threads[0]?.estimatedContextTokens).toBe(
      roughTokenEstimateFromCharacters("Hello there".length),
    );
    expect(afterMessage.threads[0]?.session?.tokenUsageSource).toBe("estimated");
    expect(afterMessage.threads[0]?.session?.estimatedContextTokens).toBe(
      roughTokenEstimateFromCharacters("Hello there".length),
    );
  });

  it("preserves hidden-context baseline when estimated token usage is updated from message traffic", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const sessionAt = "2026-02-23T08:00:05.000Z";
    const messageAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.4",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterSession = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: sessionAt,
          commandId: "cmd-session",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              estimatedContextTokens: 1_500,
              tokenUsageSource: "estimated",
              updatedAt: sessionAt,
            },
          },
        }),
      ),
    );

    const afterMessage = await Effect.runPromise(
      projectEvent(
        afterSession,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: messageAt,
          commandId: "cmd-message",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            role: "user",
            text: "Hello there",
            turnId: null,
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        }),
      ),
    );

    expect(afterMessage.threads[0]?.estimatedContextTokens).toBe(
      1_500 + roughTokenEstimateFromCharacters("Hello there".length),
    );
    expect(afterMessage.threads[0]?.session?.estimatedContextTokens).toBe(
      1_500 + roughTokenEstimateFromCharacters("Hello there".length),
    );
    expect(afterMessage.threads[0]?.session?.tokenUsageSource).toBe("estimated");
  });

  it("projects thread.tasks.updated onto the thread read model", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:03:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterTasks = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.tasks.updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-tasks",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            updatedAt,
            tasks: [
              {
                id: "task-1",
                content: "Run tests",
                activeForm: "Running tests",
                status: "in_progress",
              },
              {
                id: "task-2",
                content: "Summarize changes",
                activeForm: "Summarizing changes",
                status: "pending",
              },
            ],
          },
        }),
      ),
    );

    expect(afterTasks.threads[0]?.tasks).toEqual([
      {
        id: "task-1",
        content: "Run tests",
        activeForm: "Running tests",
        status: "in_progress",
      },
      {
        id: "task-2",
        content: "Summarize changes",
        activeForm: "Summarizing changes",
        status: "pending",
      },
    ]);
    expect(afterTasks.threads[0]?.tasksTurnId).toBe("turn-1");
    expect(afterTasks.threads[0]?.tasksUpdatedAt).toBe(updatedAt);
    expect(afterTasks.threads[0]?.updatedAt).toBe(updatedAt);
    expect(afterTasks.threads[0]?.lastInteractionAt).toBe(updatedAt);
  });

  it("upserts project workflows even when the workflow is not already present", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 3,
          type: "project.workflow-upserted",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: now,
          commandId: "cmd-workflow-upsert",
          payload: {
            projectId: "project-1",
            workflow: {
              id: "workflow-1",
              projectId: "project-1",
              title: "Planning workflow",
              slug: "planning-workflow",
              requirementPrompt: "Ship it",
              plansDirectory: "plans",
              selfReviewEnabled: true,
              branchA: {
                branchId: "a",
                authorSlot: { provider: "codex", model: "gpt-5-codex" },
                authorThreadId: "thread-a",
                planFilePath: null,
                planTurnId: null,
                revisionTurnId: null,
                reviews: [],
                status: "pending",
                error: null,
                updatedAt: now,
              },
              branchB: {
                branchId: "b",
                authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
                authorThreadId: "thread-b",
                planFilePath: null,
                planTurnId: null,
                revisionTurnId: null,
                reviews: [],
                status: "pending",
                error: null,
                updatedAt: now,
              },
              merge: {
                mergeSlot: { provider: "codex", model: "gpt-5-codex" },
                threadId: null,
                outputFilePath: null,
                turnId: null,
                status: "not_started",
                error: null,
                updatedAt: now,
              },
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              deletedAt: null,
            },
          },
        }),
      ),
    );

    expect(next.planningWorkflows).toHaveLength(1);
    expect(next.planningWorkflows[0]?.id).toBe("workflow-1");
    expect(next.planningWorkflows[0]?.selfReviewEnabled).toBe(true);
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("toggles archivedAt for thread archive lifecycle events", async () => {
    const createdAt = "2026-03-10T08:00:00.000Z";
    const archivedAt = "2026-03-10T08:05:00.000Z";
    const unarchivedAt = "2026-03-10T08:10:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterArchive = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: archivedAt,
          commandId: "cmd-archive",
          payload: {
            threadId: "thread-1",
            archivedAt,
          },
        }),
      ),
    );

    expect(afterArchive.threads[0]?.archivedAt).toBe(archivedAt);
    expect(afterArchive.threads[0]?.lastInteractionAt).toBe(createdAt);

    const afterUnarchive = await Effect.runPromise(
      projectEvent(
        afterArchive,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: unarchivedAt,
          commandId: "cmd-unarchive",
          payload: {
            threadId: "thread-1",
            unarchivedAt,
          },
        }),
      ),
    );

    expect(afterUnarchive.threads[0]?.archivedAt).toBeNull();
    expect(afterUnarchive.threads[0]?.lastInteractionAt).toBe(createdAt);
  });

  it("does not change lastInteractionAt for metadata-only thread updates", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const interactionAt = "2026-02-23T08:00:05.000Z";
    const renamedAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterMessage = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: interactionAt,
          commandId: "cmd-message",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            createdAt: interactionAt,
            updatedAt: interactionAt,
          },
        }),
      ),
    );

    const afterRename = await Effect.runPromise(
      projectEvent(
        afterMessage,
        makeEvent({
          sequence: 3,
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: renamedAt,
          commandId: "cmd-rename",
          payload: {
            threadId: "thread-1",
            title: "renamed",
            updatedAt: renamedAt,
          },
        }),
      ),
    );

    expect(afterRename.threads[0]?.lastInteractionAt).toBe(interactionAt);
    expect(afterRename.threads[0]?.updatedAt).toBe(renamedAt);
  });

  it("does not change lastInteractionAt for lifecycle-only session status changes", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const interactionAt = "2026-02-23T08:00:05.000Z";
    const readyAt = "2026-02-23T08:00:10.000Z";
    const stoppedAt = "2026-02-23T08:00:11.000Z";
    const errorAt = "2026-02-23T08:00:12.000Z";
    const model = createEmptyReadModel(createdAt);

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          model: "gpt-5.3-codex",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: interactionAt,
        commandId: "cmd-message",
        payload: {
          threadId: "thread-1",
          messageId: "message-1",
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: interactionAt,
          updatedAt: interactionAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: readyAt,
        commandId: "cmd-ready",
        payload: {
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
            status: "ready",
            providerName: "codex",
            providerSessionId: "session-1",
            providerThreadId: "provider-thread-1",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: readyAt,
          },
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: stoppedAt,
        commandId: "cmd-stopped",
        payload: {
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
            status: "stopped",
            providerName: "codex",
            providerSessionId: "session-1",
            providerThreadId: "provider-thread-1",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: errorAt,
        commandId: "cmd-error",
        payload: {
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
            status: "error",
            providerName: "codex",
            providerSessionId: "session-1",
            providerThreadId: "provider-thread-1",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "boom",
            updatedAt: errorAt,
          },
        },
      }),
    ];

    const finalState = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(model),
    );

    expect(finalState.threads[0]?.lastInteractionAt).toBe(interactionAt);
    expect(finalState.threads[0]?.updatedAt).toBe(errorAt);
  });

  it("bumps lastInteractionAt for interaction events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const messageAt = "2026-02-23T08:00:01.000Z";
    const planAt = "2026-02-23T08:00:02.000Z";
    const activityAt = "2026-02-23T08:00:03.000Z";
    const checkpointAt = "2026-02-23T08:00:04.000Z";
    const revertedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    expect(afterCreate.threads[0]?.lastInteractionAt).toBe(createdAt);

    const afterMessage = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: messageAt,
          commandId: "cmd-message",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        }),
      ),
    );
    expect(afterMessage.threads[0]?.lastInteractionAt).toBe(messageAt);

    const afterPlan = await Effect.runPromise(
      projectEvent(
        afterMessage,
        makeEvent({
          sequence: 3,
          type: "thread.proposed-plan-upserted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: planAt,
          commandId: "cmd-plan",
          payload: {
            threadId: "thread-1",
            proposedPlan: {
              id: "plan-1",
              turnId: "turn-1",
              planMarkdown: "1. Do the thing",
              createdAt: planAt,
              updatedAt: planAt,
            },
          },
        }),
      ),
    );
    expect(afterPlan.threads[0]?.lastInteractionAt).toBe(planAt);

    const afterActivity = await Effect.runPromise(
      projectEvent(
        afterPlan,
        makeEvent({
          sequence: 4,
          type: "thread.activity-appended",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: activityAt,
          commandId: "cmd-activity",
          payload: {
            threadId: "thread-1",
            activity: {
              id: "activity-1",
              tone: "tool",
              kind: "tool.started",
              summary: "Started",
              payload: {},
              turnId: "turn-1",
              createdAt: activityAt,
            },
          },
        }),
      ),
    );
    expect(afterActivity.threads[0]?.lastInteractionAt).toBe(activityAt);

    const afterCheckpoint = await Effect.runPromise(
      projectEvent(
        afterActivity,
        makeEvent({
          sequence: 5,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: checkpointAt,
          commandId: "cmd-checkpoint",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
            status: "ready",
            files: [],
            assistantMessageId: "message-1",
            completedAt: checkpointAt,
          },
        }),
      ),
    );
    expect(afterCheckpoint.threads[0]?.lastInteractionAt).toBe(checkpointAt);

    const afterReverted = await Effect.runPromise(
      projectEvent(
        afterCheckpoint,
        makeEvent({
          sequence: 6,
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: revertedAt,
          commandId: "cmd-revert",
          payload: {
            threadId: "thread-1",
            turnCount: 0,
          },
        }),
      ),
    );
    expect(afterReverted.threads[0]?.lastInteractionAt).toBe(revertedAt);
  });

  it("clears the latest task snapshot on revert", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const tasksAt = "2026-02-23T08:00:01.000Z";
    const revertedAt = "2026-02-23T08:00:02.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterTasks = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.tasks.updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: tasksAt,
          commandId: "cmd-thread-tasks",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            updatedAt: tasksAt,
            tasks: [
              {
                id: "task-1",
                content: "Inspect implementation",
                activeForm: "Inspecting implementation",
                status: "completed",
              },
              {
                id: "task-2",
                content: "Apply patch",
                activeForm: "Applying patch",
                status: "in_progress",
              },
            ],
          },
        }),
      ),
    );
    expect(afterTasks.threads[0]?.tasks).toHaveLength(2);

    const afterReverted = await Effect.runPromise(
      projectEvent(
        afterTasks,
        makeEvent({
          sequence: 3,
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: revertedAt,
          commandId: "cmd-thread-revert",
          payload: {
            threadId: "thread-1",
            turnCount: 0,
          },
        }),
      ),
    );

    expect(afterReverted.threads[0]?.tasks).toEqual([]);
  });

  it("bumps lastInteractionAt for request events that represent direct user actions", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const interruptAt = "2026-02-23T08:00:01.000Z";
    const approvalAt = "2026-02-23T08:00:02.000Z";
    const userInputAt = "2026-02-23T08:00:03.000Z";
    const stopAt = "2026-02-23T08:00:04.000Z";
    const checkpointRevertAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          model: "gpt-5.3-codex",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.turn-interrupt-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: interruptAt,
        commandId: "cmd-interrupt",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          createdAt: interruptAt,
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.approval-response-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: approvalAt,
        commandId: "cmd-approval",
        payload: {
          threadId: "thread-1",
          requestId: "request-1",
          decision: "accept",
          createdAt: approvalAt,
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.user-input-response-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: userInputAt,
        commandId: "cmd-user-input",
        payload: {
          threadId: "thread-1",
          requestId: "request-2",
          answers: { answer: "yes" },
          createdAt: userInputAt,
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.session-stop-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: stopAt,
        commandId: "cmd-stop",
        payload: {
          threadId: "thread-1",
          createdAt: stopAt,
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.checkpoint-revert-requested",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: checkpointRevertAt,
        commandId: "cmd-checkpoint-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
          createdAt: checkpointRevertAt,
        },
      }),
    ];

    const finalState = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(model),
    );

    expect(finalState.threads[0]?.lastInteractionAt).toBe(checkpointRevertAt);
    expect(finalState.threads[0]?.updatedAt).toBe(checkpointRevertAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });

  it("accumulates assistant reasoning text across message events", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            model: "gpt-5.3-codex",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-03-01T10:00:01.000Z",
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant-1",
            role: "assistant",
            text: "",
            reasoningText: "first ",
            turnId: null,
            streaming: true,
            createdAt: "2026-03-01T10:00:01.000Z",
            updatedAt: "2026-03-01T10:00:01.000Z",
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-03-01T10:00:02.000Z",
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant-1",
            role: "assistant",
            text: "answer",
            reasoningText: "second",
            turnId: null,
            streaming: false,
            createdAt: "2026-03-01T10:00:01.000Z",
            updatedAt: "2026-03-01T10:00:02.000Z",
          },
        }),
      ),
    );

    expect(afterComplete.threads[0]?.messages).toContainEqual(
      expect.objectContaining({
        id: "assistant-1",
        text: "answer",
        reasoningText: "second",
        streaming: false,
      }),
    );
  });
});
