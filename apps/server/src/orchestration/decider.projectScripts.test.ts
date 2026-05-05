import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  PlanningWorkflowId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

describe("decider project scripts", () => {
  it("emits empty scripts on project.create", async () => {
    const now = new Date().toISOString();
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("rejects project.workflow.create when the slug already exists in the same project", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-workflow"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-workflow"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-workflow"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-workflow-created"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.workflow-created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-workflow-created"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-workflow-created"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          workflow: {
            id: PlanningWorkflowId.makeUnsafe("workflow-1"),
            projectId: asProjectId("project-1"),
            title: "Planning workflow",
            slug: "planning-workflow",
            requirementPrompt: "Ship it",
            plansDirectory: "plans",
            selfReviewEnabled: true,
            branchA: {
              branchId: "a",
              authorSlot: { provider: "codex", model: "gpt-5-codex" },
              authorThreadId: ThreadId.makeUnsafe("thread-a"),
              planFilePath: null,
              planTurnId: null,
              revisionTurnId: null,
              reviews: [],
              status: "pending",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: now,
            },
            branchB: {
              branchId: "b",
              authorSlot: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
              authorThreadId: ThreadId.makeUnsafe("thread-b"),
              planFilePath: null,
              planTurnId: null,
              revisionTurnId: null,
              reviews: [],
              status: "pending",
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: now,
            },
            merge: {
              mergeSlot: { provider: "codex", model: "gpt-5-codex" },
              threadId: null,
              outputFilePath: null,
              turnId: null,
              approvedPlanId: null,
              status: "not_started",
              error: null,
              updatedAt: now,
            },
            implementation: null,
            totalCostUsd: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.workflow.create",
            commandId: CommandId.makeUnsafe("cmd-workflow-create-duplicate"),
            workflowId: PlanningWorkflowId.makeUnsafe("workflow-2"),
            projectId: asProjectId("project-1"),
            title: "Planning workflow",
            slug: "planning-workflow",
            requirementPrompt: "Ship it again",
            plansDirectory: "plans",
            authorThreadIdA: ThreadId.makeUnsafe("thread-a-2"),
            authorThreadIdB: ThreadId.makeUnsafe("thread-b-2"),
            selfReviewEnabled: true,
            branchA: { provider: "codex", model: "gpt-5-codex" },
            branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
            merge: { provider: "codex", model: "gpt-5-codex" },
            createdAt: now,
          },
          readModel,
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          provider: "codex",
          model: "gpt-5.3-codex",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          titleGenerationModel: "gpt-5.3-codex",
          titleGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
          },
          titleSourceText: "",
          modelOptions: {
            codex: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload.assistantDeliveryMode).toBe("buffered");
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("message-user-1"),
      provider: "codex",
      model: "gpt-5.3-codex",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
      titleGenerationModel: "gpt-5.3-codex",
      titleGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
      titleSourceText: "",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "approval-required",
    });
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe("cmd-runtime-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-interaction-mode-set"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
      },
    });
  });

  it("emits thread.archived from thread.archive using the command createdAt", async () => {
    const createdAt = "2026-03-10T08:00:00.000Z";
    const initial = createEmptyReadModel(createdAt);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-archive"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-project-create-archive"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-archive"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-archive"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-thread-create-archive"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-archive"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-thread-archive"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single thread.archived event.");
    }
    expect(singleResult).toMatchObject({
      occurredAt: createdAt,
      type: "thread.archived",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        archivedAt: createdAt,
      },
    });
  });

  it("emits thread.unarchived from thread.unarchive and rejects duplicate archive state changes", async () => {
    const createdAt = "2026-03-10T08:30:00.000Z";
    const archivedAt = "2026-03-10T08:35:00.000Z";
    const unarchivedAt = "2026-03-10T08:40:00.000Z";
    const initial = createEmptyReadModel(createdAt);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-unarchive"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-project-create-unarchive"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create-unarchive"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModel: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );
    const unarchivedReadModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create-unarchive"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.created",
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-thread-create-unarchive"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create-unarchive"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );
    const archivedReadModel = await Effect.runPromise(
      projectEvent(unarchivedReadModel, {
        sequence: 3,
        eventId: asEventId("evt-thread-archived"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        type: "thread.archived",
        occurredAt: archivedAt,
        commandId: CommandId.makeUnsafe("cmd-thread-archive"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-archive"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          archivedAt,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-thread-unarchive"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: unarchivedAt,
        },
        readModel: archivedReadModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single thread.unarchived event.");
    }
    expect(singleResult).toMatchObject({
      occurredAt: unarchivedAt,
      type: "thread.unarchived",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        unarchivedAt,
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-thread-archive-duplicate"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: unarchivedAt,
          },
          readModel: archivedReadModel,
        }),
      ),
    ).rejects.toThrow("already archived");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.unarchive",
            commandId: CommandId.makeUnsafe("cmd-thread-unarchive-invalid"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: unarchivedAt,
          },
          readModel: unarchivedReadModel,
        }),
      ),
    ).rejects.toThrow("is not archived");
  });
});
