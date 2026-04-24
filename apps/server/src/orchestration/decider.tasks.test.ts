import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-03T17:00:00.000Z";

async function createThreadReadModel() {
  const initial = createEmptyReadModel(NOW);
  return Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-thread-created"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-thread-created"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-created"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

function makeTasksUpdateCommand(
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
    readonly activeForm: string;
    readonly status: "pending" | "in_progress" | "completed";
  }>,
) {
  return {
    type: "thread.tasks.update" as const,
    commandId: CommandId.makeUnsafe(`cmd-thread-tasks-${crypto.randomUUID()}`),
    threadId: ThreadId.makeUnsafe("thread-1"),
    tasks: [...tasks],
    createdAt: NOW,
  };
}

describe("decider task validation", () => {
  it("emits thread.tasks.updated for a valid in-progress task snapshot", async () => {
    const readModel = await createThreadReadModel();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeTasksUpdateCommand([
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
        ]),
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.tasks.updated");
    expect((event.payload as { tasks: unknown }).tasks).toEqual([
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
    ]);
  });

  it("rejects duplicate task ids", async () => {
    const readModel = await createThreadReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeTasksUpdateCommand([
            {
              id: "task-dup",
              content: "Inspect implementation",
              activeForm: "Inspecting implementation",
              status: "completed",
            },
            {
              id: "task-dup",
              content: "Apply patch",
              activeForm: "Applying patch",
              status: "in_progress",
            },
          ]),
          readModel,
        }),
      ),
    ).rejects.toThrow("duplicate id 'task-dup'");
  });

  it("rejects multiple in-progress tasks", async () => {
    const readModel = await createThreadReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeTasksUpdateCommand([
            {
              id: "task-1",
              content: "Inspect implementation",
              activeForm: "Inspecting implementation",
              status: "in_progress",
            },
            {
              id: "task-2",
              content: "Apply patch",
              activeForm: "Applying patch",
              status: "in_progress",
            },
          ]),
          readModel,
        }),
      ),
    ).rejects.toThrow("Only one task may be in_progress at a time.");
  });

  it("rejects incomplete task snapshots without an in-progress task", async () => {
    const readModel = await createThreadReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeTasksUpdateCommand([
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
              status: "pending",
            },
          ]),
          readModel,
        }),
      ),
    ).rejects.toThrow("An incomplete task list must have exactly one task in_progress.");
  });

  it("accepts fully completed task snapshots", async () => {
    const readModel = await createThreadReadModel();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeTasksUpdateCommand([
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
            status: "completed",
          },
        ]),
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.tasks.updated");
  });

  it("accepts empty task snapshots", async () => {
    const readModel = await createThreadReadModel();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: makeTasksUpdateCommand([]),
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.tasks.updated");
    expect((event.payload as { tasks: unknown[] }).tasks).toEqual([]);
  });
});
