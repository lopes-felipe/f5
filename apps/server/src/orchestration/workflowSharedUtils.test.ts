import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  getFinishedConsumableLatestTurn,
  latestAssistantFeedback,
  latestAssistantText,
} from "./workflowSharedUtils.ts";

type TestMessage = {
  readonly id: string;
  readonly role: "assistant" | "system" | "user";
  readonly text: string;
  readonly reasoningText?: string;
  readonly streaming: boolean;
  readonly turnId?: string | null;
};

type TestThread = {
  readonly latestTurn: { readonly assistantMessageId: string | null } | null;
  readonly messages: ReadonlyArray<TestMessage>;
};

function makeThread(
  messages: ReadonlyArray<TestMessage>,
  assistantMessageId: string | null = null,
): TestThread {
  return {
    latestTurn: { assistantMessageId },
    messages,
  };
}

function makeConsumableThread(input: {
  readonly messages: ReadonlyArray<TestMessage>;
  readonly assistantMessageId?: string | null;
  readonly turnId?: string;
  readonly state?: "completed" | "running";
  readonly session?: {
    readonly status: "ready" | "running";
    readonly activeTurnId: string | null;
  } | null;
}): NonNullable<Parameters<typeof getFinishedConsumableLatestTurn>[0]> {
  const turnId = TurnId.makeUnsafe(input.turnId ?? "turn-1");
  const assistantMessageId =
    input.assistantMessageId === null
      ? null
      : MessageId.makeUnsafe(input.assistantMessageId ?? input.messages[0]?.id ?? "m1");
  return {
    latestTurn: {
      turnId,
      state: input.state ?? "completed",
      assistantMessageId,
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: (input.state ?? "completed") === "completed" ? "2026-01-01T00:00:01.000Z" : null,
    },
    session:
      input.session === null
        ? null
        : {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: input.session?.status ?? ("ready" as const),
            providerName: "codex",
            runtimeMode: "full-access" as const,
            activeTurnId:
              input.session?.activeTurnId === null || input.session?.activeTurnId === undefined
                ? null
                : TurnId.makeUnsafe(input.session.activeTurnId),
            lastError: null,
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
    messages: input.messages.map((message) => ({
      ...message,
      id: MessageId.makeUnsafe(message.id),
      turnId:
        message.turnId === undefined
          ? null
          : message.turnId === null
            ? null
            : TurnId.makeUnsafe(message.turnId),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    })),
  };
}

describe("latestAssistantFeedback", () => {
  it("returns text when only text is populated", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "Concrete finding.",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Concrete finding.",
      source: "text-only",
    });
  });

  it("returns reasoningText when assistant text is empty", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "   ",
        reasoningText: "Hidden findings in reasoning.",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Hidden findings in reasoning.",
      source: "reasoning-only",
    });
  });

  it("combines text and reasoningText when both are populated", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "Preamble paragraph.",
        reasoningText: "Actual detailed findings.",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Preamble paragraph.\n\n## Reviewer reasoning\n\nActual detailed findings.",
      source: "combined",
    });
  });

  it("returns null when both fields are empty", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "",
        reasoningText: "",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toBeNull();
  });

  it("skips streaming messages and falls back to earlier ones", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "Earlier final text.",
        streaming: false,
      },
      {
        id: "m2",
        role: "assistant",
        text: "Still streaming...",
        streaming: true,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Earlier final text.",
      source: "text-only",
    });
  });

  it("prefers the message identified by latestTurn.assistantMessageId", () => {
    const thread = makeThread(
      [
        {
          id: "older",
          role: "assistant",
          text: "Outdated content.",
          streaming: false,
        },
        {
          id: "preferred",
          role: "assistant",
          text: "",
          reasoningText: "Preferred message reasoning.",
          streaming: false,
        },
      ],
      "preferred",
    );
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Preferred message reasoning.",
      source: "reasoning-only",
    });
  });

  it("ignores user messages when falling back", () => {
    const thread = makeThread([
      {
        id: "u1",
        role: "user",
        text: "User text that should be ignored.",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        text: "Assistant text.",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Assistant text.",
      source: "text-only",
    });
  });

  it("handles missing reasoningText field (undefined)", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "Only text available.",
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Only text available.",
      source: "text-only",
    });
  });

  it("treats an absent reasoningText field like an empty value", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "Final text.",
        // reasoningText intentionally omitted.
        streaming: false,
      },
    ]);
    expect(latestAssistantFeedback(thread)).toEqual({
      text: "Final text.",
      source: "text-only",
    });
  });
});

describe("latestAssistantText (unchanged by reasoning additions)", () => {
  it("still returns only message.text and ignores reasoningText", () => {
    const thread = makeThread([
      {
        id: "m1",
        role: "assistant",
        text: "",
        reasoningText: "Reasoning only; must not be returned here.",
        streaming: false,
      },
    ]);
    // Consumers like ProposedPlanSynthesisService intentionally rely on this narrow behavior.
    expect(latestAssistantText(thread)).toBeNull();
  });
});

describe("getFinishedConsumableLatestTurn", () => {
  it("returns a completed reasoning-only assistant message", () => {
    const thread = makeConsumableThread({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "",
          reasoningText: "Hidden plan in reasoning.",
          streaming: false,
          turnId: "turn-1",
        },
      ],
    });

    expect(getFinishedConsumableLatestTurn(thread)).toEqual({
      turnId: "turn-1",
      assistantMessageId: "m1",
      assistantText: "Hidden plan in reasoning.",
    });
  });

  it("prefers assistant text over reasoning when both are populated", () => {
    const thread = makeConsumableThread({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "Public assistant text.",
          reasoningText: "Internal reasoning text.",
          streaming: false,
          turnId: "turn-1",
        },
      ],
    });

    expect(getFinishedConsumableLatestTurn(thread)).toEqual({
      turnId: "turn-1",
      assistantMessageId: "m1",
      assistantText: "Public assistant text.",
    });
  });

  it("returns null when both assistant text and reasoning are empty", () => {
    const thread = makeConsumableThread({
      messages: [
        {
          id: "m1",
          role: "assistant",
          text: "   ",
          reasoningText: "   ",
          streaming: false,
          turnId: "turn-1",
        },
      ],
    });

    expect(getFinishedConsumableLatestTurn(thread)).toBeNull();
  });
});
