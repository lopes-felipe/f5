import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
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
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("projector compaction state", () => {
  it("projects thread.compacted onto the thread read model", async () => {
    const createdAt = "2026-04-03T10:00:00.000Z";
    const compactedAt = "2026-04-03T10:01:00.000Z";
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
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterCompaction = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.compacted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: compactedAt,
          commandId: "cmd-compacted",
          payload: {
            threadId: "thread-1",
            compaction: {
              summary: "Summary:\n1. Finished phase 4",
              trigger: "manual",
              estimatedTokens: 12345,
              modelContextWindowTokens: 1000000,
              createdAt: compactedAt,
              direction: null,
              pivotMessageId: null,
              fromTurnCount: 1,
              toTurnCount: 4,
            },
          },
        }),
      ),
    );

    expect(afterCompaction.threads[0]?.compaction?.summary).toContain("Finished phase 4");
    expect(afterCompaction.threads[0]?.estimatedContextTokens).toBe(12_345);
    expect(afterCompaction.threads[0]?.updatedAt).toBe(compactedAt);
    expect(afterCompaction.threads[0]?.lastInteractionAt).toBe(compactedAt);
  });

  it("clears compaction state on revert", async () => {
    const createdAt = "2026-04-03T10:00:00.000Z";
    const compactedAt = "2026-04-03T10:01:00.000Z";
    const revertedAt = "2026-04-03T10:02:00.000Z";
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
            model: "claude-sonnet-4-6",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterCompaction = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.compacted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: compactedAt,
          commandId: "cmd-compacted",
          payload: {
            threadId: "thread-1",
            compaction: {
              summary: "Summary:\n1. Finished phase 4",
              trigger: "automatic",
              estimatedTokens: 160000,
              modelContextWindowTokens: 1000000,
              createdAt: compactedAt,
              direction: null,
              pivotMessageId: null,
              fromTurnCount: 1,
              toTurnCount: 4,
            },
          },
        }),
      ),
    );

    const afterRevert = await Effect.runPromise(
      projectEvent(
        afterCompaction,
        makeEvent({
          sequence: 3,
          type: "thread.reverted",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: revertedAt,
          commandId: "cmd-reverted",
          payload: {
            threadId: "thread-1",
            turnCount: 0,
          },
        }),
      ),
    );

    expect(afterRevert.threads[0]?.compaction).toBeNull();
    expect(afterRevert.threads[0]?.estimatedContextTokens).toBeNull();
  });
});
