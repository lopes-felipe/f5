import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-03T17:00:00.000Z";

async function createProjectReadModel() {
  const initial = createEmptyReadModel(NOW);
  return Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-created"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-project-created"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-created"),
      metadata: {},
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "claude-sonnet-4-6",
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

function makeSaveCommand(
  overrides?: Partial<{
    memoryId: string;
    scope: "user" | "project";
    memoryType: "user" | "feedback" | "project" | "reference";
    name: string;
    description: string;
    body: string;
    createdAt: string;
  }>,
) {
  return {
    type: "project.memory.save" as const,
    commandId: CommandId.makeUnsafe(`cmd-memory-save-${crypto.randomUUID()}`),
    projectId: ProjectId.makeUnsafe("project-1"),
    memoryId: overrides?.memoryId ?? "memory-1",
    scope: overrides?.scope ?? "user",
    memoryType: overrides?.memoryType ?? "feedback",
    name: overrides?.name ?? "Avoid extra comments",
    description: overrides?.description ?? "Keep explanations terse.",
    body: overrides?.body ?? "Do not add unnecessary comments.",
    createdAt: overrides?.createdAt ?? NOW,
  };
}

async function applySavedMemory(readModel: Awaited<ReturnType<typeof createProjectReadModel>>) {
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: makeSaveCommand(),
      readModel,
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  return Effect.runPromise(projectEvent(readModel, { ...event, sequence: 2 }));
}

describe("decider project memories", () => {
  it("emits project.memory-saved for a new memory", async () => {
    const readModel = await createProjectReadModel();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.memory.save",
          commandId: CommandId.makeUnsafe("cmd-memory-save"),
          projectId: ProjectId.makeUnsafe("project-1"),
          memoryId: "memory-1",
          scope: "user",
          memoryType: "feedback",
          name: "Avoid extra comments",
          description: "Keep explanations terse.",
          body: "Do not add unnecessary comments.",
          createdAt: NOW,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.memory-saved");
    expect((event.payload as { memory: { name: string } }).memory.name).toBe(
      "Avoid extra comments",
    );
  });

  it("rejects updates for missing memories", async () => {
    const readModel = await createProjectReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.memory.update",
            commandId: CommandId.makeUnsafe("cmd-memory-update"),
            projectId: ProjectId.makeUnsafe("project-1"),
            memoryId: "missing-memory",
            scope: "user",
            memoryType: "feedback",
            name: "Avoid extra comments",
            description: "Keep explanations terse.",
            body: "Do not add unnecessary comments.",
            updatedAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("updates an existing memory", async () => {
    const readModel = await createProjectReadModel();
    const readModelWithMemory = await applySavedMemory(readModel);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.memory.update",
          commandId: CommandId.makeUnsafe("cmd-memory-update-existing"),
          projectId: ProjectId.makeUnsafe("project-1"),
          memoryId: "memory-1",
          scope: "project",
          memoryType: "reference",
          name: "Updated memory",
          description: "Updated description.",
          body: "Updated body.",
          updatedAt: NOW,
        },
        readModel: readModelWithMemory,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.memory-updated");
    expect(
      (event.payload as { memory: { scope: string; type: string; name: string } }).memory,
    ).toEqual(
      expect.objectContaining({
        scope: "project",
        type: "reference",
        name: "Updated memory",
      }),
    );
  });

  it("deletes an existing memory", async () => {
    const readModel = await createProjectReadModel();
    const readModelWithMemory = await applySavedMemory(readModel);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.memory.delete",
          commandId: CommandId.makeUnsafe("cmd-memory-delete"),
          projectId: ProjectId.makeUnsafe("project-1"),
          memoryId: "memory-1",
          deletedAt: NOW,
        },
        readModel: readModelWithMemory,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.memory-deleted");
    expect((event.payload as { memoryId: string }).memoryId).toBe("memory-1");
  });

  it("rejects duplicate memory ids within the same project", async () => {
    const readModel = await createProjectReadModel();
    const readModelWithMemory = await applySavedMemory(readModel);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: makeSaveCommand(),
          readModel: readModelWithMemory,
        }),
      ),
    ).rejects.toThrow("already exists");
  });
});
