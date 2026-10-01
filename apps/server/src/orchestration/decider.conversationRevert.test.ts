import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-1");
const userMessageId = MessageId.makeUnsafe("user-1");
const assistantMessageId = MessageId.makeUnsafe("assistant-1");

const eventBase = (sequence: number, name: string) => ({
  sequence,
  eventId: EventId.makeUnsafe(`evt-${name}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: NOW,
  commandId: CommandId.makeUnsafe(`cmd-${name}`),
  causationEventId: null,
  correlationId: CommandId.makeUnsafe(`cmd-${name}`),
  metadata: {},
});

async function readModelWithConversation() {
  let model = createEmptyReadModel(NOW);
  model = await Effect.runPromise(
    projectEvent(model, {
      ...eventBase(1, "thread-created"),
      type: "thread.created",
      payload: {
        threadId,
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
  for (const [index, [messageId, role]] of (
    [
      [userMessageId, "user"],
      [assistantMessageId, "assistant"],
    ] as const
  ).entries()) {
    model = await Effect.runPromise(
      projectEvent(model, {
        ...eventBase(index + 2, messageId),
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId,
          role,
          text: role,
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
  }
  return model;
}

const revert = (expectedLatestMessageId?: MessageId) => ({
  type: "thread.conversation.revert" as const,
  commandId: CommandId.makeUnsafe("cmd-revert"),
  operationId: CommandId.makeUnsafe("op-revert"),
  threadId,
  targetMessageId: userMessageId,
  restoreFiles: false,
  ...(expectedLatestMessageId ? { expectedLatestMessageId } : {}),
  createdAt: NOW,
});

describe("decider conversation revert", () => {
  it("accepts a revert confirmed against the thread's latest message", async () => {
    const readModel = await readModelWithConversation();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: revert(assistantMessageId), readModel }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events[0]?.type).toBe("thread.conversation-revert-requested");
  });

  it("is not invalidated by activity elsewhere, only by this thread moving on", async () => {
    const readModel = await readModelWithConversation();
    // Other threads advance the global snapshot sequence; that must not matter.
    const busyModel = { ...readModel, snapshotSequence: readModel.snapshotSequence + 50 };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: revert(assistantMessageId), readModel: busyModel }),
      ),
    ).resolves.toBeDefined();

    const error = await Effect.runPromise(
      Effect.flip(decideOrchestrationCommand({ command: revert(userMessageId), readModel })),
    );
    expect(String(error.message ?? error)).toContain("New messages arrived");
  });
});
