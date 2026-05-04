import {
  CommandId,
  EventId,
  ProjectId,
  ProjectCreatedPayload,
  ThreadId,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-20T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

type ProjectCreatedEvent = Extract<OrchestrationEvent, { type: "project.created" }>;
type ThreadCreatedEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;
type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

function eventBase(sequence: number) {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as const;
}

function projectCreatedEvent(
  sequence: number,
  payload: typeof ProjectCreatedPayload.Type,
): ProjectCreatedEvent {
  const event = {
    ...eventBase(sequence),
    type: "project.created",
    aggregateKind: "project",
    aggregateId: payload.projectId,
    payload,
  } satisfies ProjectCreatedEvent;
  return event;
}

function threadCreatedEvent(
  sequence: number,
  payload: typeof ThreadCreatedPayload.Type,
): ThreadCreatedEvent {
  const event = {
    ...eventBase(sequence),
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: payload.threadId,
    payload,
  } satisfies ThreadCreatedEvent;
  return event;
}

function threadDeletedEvent(
  sequence: number,
  payload: typeof ThreadDeletedPayload.Type,
): ThreadDeletedEvent {
  const event = {
    ...eventBase(sequence),
    type: "thread.deleted",
    aggregateKind: "thread",
    aggregateId: payload.threadId,
    payload,
  } satisfies ThreadDeletedEvent;
  return event;
}

async function createProjectReadModel() {
  return Effect.runPromise(
    projectEvent(
      createEmptyReadModel(NOW),
      projectCreatedEvent(1, {
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo",
        defaultModel: "gpt-5.5",
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
  );
}

async function createProjectWithThreadReadModel() {
  const withProject = await createProjectReadModel();
  return Effect.runPromise(
    projectEvent(
      withProject,
      threadCreatedEvent(2, {
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        model: "gpt-5.5",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ),
  );
}

describe("decider project.delete", () => {
  it("rejects deleting projects with active child threads", async () => {
    const readModel = await createProjectWithThreadReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: CommandId.makeUnsafe("delete-project"),
            projectId: PROJECT_ID,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("is not empty");
  });

  it("allows deleting projects after child threads are deleted", async () => {
    const withThread = await createProjectWithThreadReadModel();
    const withDeletedThread = await Effect.runPromise(
      projectEvent(
        withThread,
        threadDeletedEvent(3, {
          threadId: THREAD_ID,
          deletedAt: NOW,
        }),
      ),
    );

    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.makeUnsafe("delete-project"),
          projectId: PROJECT_ID,
        },
        readModel: withDeletedThread,
      }),
    );

    if (Array.isArray(event)) {
      throw new Error("Expected a single project.deleted event.");
    }
    expect((event as { type: string }).type).toBe("project.deleted");
  });
});
