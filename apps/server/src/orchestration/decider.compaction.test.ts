import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-03T17:00:00.000Z";

async function createThreadReadModel(input?: { readonly running?: boolean }) {
  const initial = createEmptyReadModel(NOW);
  const afterCreate = await Effect.runPromise(
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
        model: "claude-sonnet-4-6",
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );

  const afterMessage = await Effect.runPromise(
    projectEvent(afterCreate, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-message"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-message"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-message"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "compact this thread",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );

  if (!input?.running) {
    return afterMessage;
  }

  return Effect.runPromise(
    projectEvent(afterMessage, {
      sequence: 3,
      eventId: EventId.makeUnsafe("evt-session"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      type: "thread.session-set",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-session"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-session"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          lastError: null,
          updatedAt: NOW,
        },
      },
    }),
  );
}

describe("decider compaction validation", () => {
  it("emits thread.compact-requested for a valid full compaction request", async () => {
    const readModel = await createThreadReadModel();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.compact.request",
          commandId: CommandId.makeUnsafe("cmd-compact"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: NOW,
          trigger: "manual",
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.compact-requested");
    expect((event.payload as { trigger: string }).trigger).toBe("manual");
  });

  it("rejects partial compaction requests without a pivot message", async () => {
    const readModel = await createThreadReadModel();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.compact.request",
            commandId: CommandId.makeUnsafe("cmd-compact-partial"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: NOW,
            trigger: "manual",
            direction: "up_to",
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Partial compaction requires both direction and pivotMessageId.");
  });

  it("rejects compaction while a thread turn is running", async () => {
    const readModel = await createThreadReadModel({ running: true });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.compact.request",
            commandId: CommandId.makeUnsafe("cmd-compact-running"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: NOW,
            trigger: "manual",
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("Interrupt the current turn before compacting the conversation.");
  });
});
