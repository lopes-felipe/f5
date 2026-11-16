import { CommandId, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-04-20T12:00:00.000Z";

async function createThreadReadModelWithCompletedAssistantMessage() {
  const initial = createEmptyReadModel(NOW);
  const afterThreadCreate = await Effect.runPromise(
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

  return Effect.runPromise(
    projectEvent(afterThreadCreate, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-assistant-message"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      type: "thread.message-sent",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-assistant-message"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-assistant-message"),
      metadata: {},
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant:item-1"),
        role: "assistant",
        text: "hello world",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

describe("decider assistant message handling", () => {
  it("adds skill call metadata to user message events when starting a turn", async () => {
    const readModel = await createThreadReadModelWithCompletedAssistantMessage();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-skill"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: MessageId.makeUnsafe("message-skill"),
            role: "user",
            text: "$review target",
            skillCall: { name: "review" },
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );

    if (!Array.isArray(result)) {
      throw new Error("Expected turn start to produce events.");
    }
    const messageEvent = result.find((event) => event.type === "thread.message-sent");
    expect(messageEvent?.payload.skillCall).toEqual({ name: "review" });
  });

  it("omits skill call metadata from user message events when absent", async () => {
    const readModel = await createThreadReadModelWithCompletedAssistantMessage();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-no-skill"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: MessageId.makeUnsafe("message-no-skill"),
            role: "user",
            text: "plain target",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      }),
    );

    if (!Array.isArray(result)) {
      throw new Error("Expected turn start to produce events.");
    }
    const messageEvent = result.find((event) => event.type === "thread.message-sent");
    expect(messageEvent?.payload).not.toHaveProperty("skillCall");
  });

  it("drops assistant deltas for messages that are already completed", async () => {
    const readModel = await createThreadReadModelWithCompletedAssistantMessage();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("cmd-assistant-delta"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("assistant:item-1"),
          delta: " late text",
          createdAt: NOW,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });
});

describe("decider reasoning token handling", () => {
  const addTokens = (messageId: string, tokens: number, estimated: boolean) =>
    ({
      type: "thread.message.reasoning-tokens.add",
      commandId: CommandId.makeUnsafe(`cmd-reasoning-tokens-${tokens}`),
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: MessageId.makeUnsafe(messageId),
      turnId: TurnId.makeUnsafe("turn-1"),
      tokens,
      estimated,
      createdAt: NOW,
    }) as const;

  it("adds tokens to a completed assistant message and accumulates them in the projection", async () => {
    let readModel = await createThreadReadModelWithCompletedAssistantMessage();
    let sequence = 3;
    for (const [tokens, estimated] of [
      [400, false],
      [100, true],
    ] as const) {
      const result = await Effect.runPromise(
        decideOrchestrationCommand({
          command: addTokens("assistant:item-1", tokens, estimated),
          readModel,
        }),
      );
      const event = Array.isArray(result) ? result[0] : result;
      expect(event?.type).toBe("thread.message-reasoning-tokens-added");
      readModel = await Effect.runPromise(
        projectEvent(readModel, {
          ...event!,
          sequence: sequence++,
        } as Parameters<typeof projectEvent>[1]),
      );
    }

    const message = readModel.threads[0]?.messages.find((entry) => entry.id === "assistant:item-1");
    expect(message).toMatchObject({
      text: "hello world",
      streaming: false,
      reasoningTokens: 500,
      reasoningTokensEstimated: true,
    });
  });

  it("rejects tokens for a missing message", async () => {
    const readModel = await createThreadReadModelWithCompletedAssistantMessage();
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: addTokens("assistant:missing", 10, false),
          readModel,
        }),
      ),
    );
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
  });
});
