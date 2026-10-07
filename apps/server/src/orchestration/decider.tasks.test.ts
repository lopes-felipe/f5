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

  it.each([
    [
      "several in-progress tasks",
      [
        { id: "task-1", content: "Inspect", activeForm: "Inspecting", status: "in_progress" },
        { id: "task-2", content: "Patch", activeForm: "Patching", status: "in_progress" },
      ],
    ],
    [
      "an incomplete list with nothing in progress",
      [
        { id: "task-1", content: "Inspect", activeForm: "Inspecting", status: "completed" },
        { id: "task-2", content: "Patch", activeForm: "Patching", status: "pending" },
      ],
    ],
  ] as const)("accepts %s (native Task tools allow it)", async (_label, tasks) => {
    const readModel = await createThreadReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: makeTasksUpdateCommand(tasks), readModel }),
    );
    expect([result].flat()[0]?.type).toBe("thread.tasks.updated");
  });

  it("rejects more than 512 tasks", async () => {
    const readModel = await createThreadReadModel();
    const tasks = Array.from({ length: 513 }, (_, index) => ({
      id: `task-${index}`,
      content: "Task",
      activeForm: "Task",
      status: "pending" as const,
    }));
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: makeTasksUpdateCommand(tasks), readModel }),
      ),
    ).rejects.toThrow("at most 512 tasks");
  });

  it("fences native task updates computed before a revert advanced the generation", async () => {
    const readModel = await createThreadReadModel();
    const tracking = {
      version: 1 as const,
      source: "claude-task-tools" as const,
      nativeSessionId: null,
      generation: 2,
      syncState: "synced" as const,
      pendingCalls: [],
      invalidatedCallIds: [],
      handledCallIds: [],
      provenance: [],
      suppressedTaskIds: [],
    };
    const accepted = await Effect.runPromise(
      decideOrchestrationCommand({
        command: { ...makeTasksUpdateCommand([]), tracking, expectedTrackingGeneration: 0 },
        readModel,
      }),
    );
    const event = Array.isArray(accepted) ? accepted[0]! : accepted;
    expect(event.type === "thread.tasks.updated" ? event.payload.tracking : null).toEqual(tracking);

    const advanced = await Effect.runPromise(projectEvent(readModel, { ...event, sequence: 2 }));
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: { ...makeTasksUpdateCommand([]), tracking, expectedTrackingGeneration: 0 },
          readModel: advanced,
        }),
      ),
    ).rejects.toThrow("Stale task tracking generation 0; current is 2.");
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
