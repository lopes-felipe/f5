import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

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
    aggregateId: ProjectId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("projector project memories", () => {
  it("projects project.memory-saved and project.memory-deleted onto the project read model", async () => {
    const createdAt = "2026-04-03T10:00:00.000Z";
    const updatedAt = "2026-04-03T10:01:00.000Z";
    const deletedAt = "2026-04-03T10:02:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "project.created",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            projectId: "project-1",
            title: "demo",
            workspaceRoot: "/repo/project",
            defaultModel: "claude-sonnet-4-6",
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterSave = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "project.memory-saved",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: updatedAt,
          commandId: "cmd-save",
          payload: {
            projectId: "project-1",
            memory: {
              id: "memory-1",
              projectId: "project-1",
              scope: "user",
              type: "feedback",
              name: "Avoid extra comments",
              description: "Keep explanations terse.",
              body: "Do not add unnecessary comments.",
              createdAt,
              updatedAt,
              deletedAt: null,
            },
          },
        }),
      ),
    );

    expect(afterSave.projects[0]?.memories[0]?.name).toBe("Avoid extra comments");

    const afterDelete = await Effect.runPromise(
      projectEvent(
        afterSave,
        makeEvent({
          sequence: 3,
          type: "project.memory-deleted",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: deletedAt,
          commandId: "cmd-delete",
          payload: {
            projectId: "project-1",
            memoryId: "memory-1",
            deletedAt,
          },
        }),
      ),
    );

    expect(afterDelete.projects[0]?.memories[0]?.deletedAt).toBe(deletedAt);
  });
});
