import { MessageId, type OrchestrationMessage, type OrchestrationThread } from "@t3tools/contracts";
import { CONTEXT_HANDOFF_OPEN_TAG } from "@t3tools/shared/conversationHandoff";
import { describe, expect, it } from "vitest";

import {
  canResumeParkedSession,
  composeHandoffInput,
  computeHandoffAllowanceChars,
  HANDOFF_HISTORY_MAX_CHARS,
  renderProviderHandoff,
  selectHandoffSource,
  type HandoffSource,
} from "./providerHandoff.ts";

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  minute: number,
  streaming = false,
): OrchestrationMessage {
  const createdAt = `2026-10-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: null,
    streaming,
    createdAt,
    updatedAt: createdAt,
  };
}

function thread(
  messages: OrchestrationMessage[],
  compaction: OrchestrationThread["compaction"] = null,
): Pick<OrchestrationThread, "messages" | "compaction"> {
  return { messages, compaction };
}

const participants = { fromLabel: "Claude · opus" };

function source(messages: OrchestrationMessage[], summary: string | null = null): HandoffSource {
  return { effectiveMode: "full", messages, summary };
}

describe("selectHandoffSource", () => {
  const conversation = [
    message("u1", "user", "first", 1),
    message("a1", "assistant", "reply", 2),
    message("s1", "system", "system note", 3),
    message("u2", "user", "second", 4),
    message("a2", "assistant", "  ", 5),
    message("a3", "assistant", "streaming", 6, true),
    message("u3", "user", "trigger", 7),
  ];

  it("keeps settled user and assistant text and excludes the triggering message", () => {
    const selected = selectHandoffSource({
      thread: thread(conversation),
      mode: "full",
      sinceMessageId: null,
      excludeMessageId: "u3",
      targetConsumesResumedContext: false,
    });
    expect(selected.effectiveMode).toBe("full");
    expect(selected.messages.map((entry) => entry.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("sends only messages after the since id for a delta and degrades when it is gone", () => {
    const delta = selectHandoffSource({
      thread: thread(conversation),
      mode: "delta",
      sinceMessageId: "a1",
      excludeMessageId: "u3",
      targetConsumesResumedContext: false,
    });
    expect(delta.effectiveMode).toBe("delta");
    expect(delta.messages.map((entry) => entry.id)).toEqual(["u2"]);

    const degraded = selectHandoffSource({
      thread: thread(conversation),
      mode: "delta",
      sinceMessageId: "rewound-away",
      excludeMessageId: "u3",
      targetConsumesResumedContext: false,
    });
    expect(degraded.effectiveMode).toBe("full");
    expect(degraded.messages.map((entry) => entry.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("never includes submissions committed after the triggering message", () => {
    const selected = selectHandoffSource({
      thread: thread([...conversation, message("u4", "user", "queued later", 8)]),
      mode: "delta",
      sinceMessageId: "u1",
      excludeMessageId: "u3",
      targetConsumesResumedContext: false,
    });
    expect(selected.messages.map((entry) => entry.id)).toEqual(["a1", "u2"]);
  });

  it("adds an evicted first user message", () => {
    const selected = selectHandoffSource({
      thread: thread(conversation.slice(1)),
      mode: "full",
      sinceMessageId: null,
      excludeMessageId: "u3",
      targetConsumesResumedContext: false,
      evictedFirstUserMessage: message("u0", "user", "very first", 0),
    });
    expect(selected.messages.map((entry) => entry.id)).toEqual(["u0", "a1", "u2"]);
  });

  describe("with a partial summary compaction", () => {
    const messages = [
      message("u1", "user", "old", 1),
      message("a1", "assistant", "old reply", 2),
      message("u2", "user", "pivot", 3),
      message("a2", "assistant", "kept", 4),
      message("u3", "user", "after compaction", 20),
    ];
    const compaction = (direction: "from" | "up_to") => ({
      kind: "summary" as const,
      summary: "SUMMARY",
      trigger: "manual" as const,
      estimatedTokens: 10,
      modelContextWindowTokens: 100,
      createdAt: "2026-10-01T00:10:00.000Z",
      direction,
      pivotMessageId: MessageId.makeUnsafe("u2"),
      fromTurnCount: null,
      toTurnCount: null,
    });

    it("sends only post-compaction messages to Codex and Claude", () => {
      for (const direction of ["from", "up_to"] as const) {
        const selected = selectHandoffSource({
          thread: thread(messages, compaction(direction)),
          mode: "full",
          sinceMessageId: null,
          excludeMessageId: null,
          targetConsumesResumedContext: true,
        });
        expect(selected.summary).toBeNull();
        expect(selected.messages.map((entry) => entry.id)).toEqual(["u3"]);
      }
    });

    it("sends the summary plus every uncovered message to other targets", () => {
      const until = selectHandoffSource({
        thread: thread(messages, compaction("up_to")),
        mode: "full",
        sinceMessageId: null,
        excludeMessageId: null,
        targetConsumesResumedContext: false,
      });
      expect(until.summary).toBe("SUMMARY");
      expect(until.messages.map((entry) => entry.id)).toEqual(["a2", "u3"]);

      const from = selectHandoffSource({
        thread: thread(messages, compaction("from")),
        mode: "full",
        sinceMessageId: null,
        excludeMessageId: null,
        targetConsumesResumedContext: false,
      });
      expect(from.messages.map((entry) => entry.id)).toEqual(["u1", "a1", "u3"]);
    });
  });
});

describe("computeHandoffAllowanceChars", () => {
  it("caps the allowance and shrinks it for the request and attachments", () => {
    const base = computeHandoffAllowanceChars({
      windowTokens: 1_000_000,
      requestChars: 10,
      imageCount: 0,
      otherAttachmentCount: 0,
    });
    expect(base).toBe(HANDOFF_HISTORY_MAX_CHARS);
    const small = { windowTokens: 40_000, requestChars: 0, imageCount: 0, otherAttachmentCount: 0 };
    // reserve = 16k tokens, so 24k tokens remain: capped at 32k chars.
    expect(computeHandoffAllowanceChars(small)).toBe(32_000);
    expect(
      computeHandoffAllowanceChars({ ...small, requestChars: 4 * 20_000, imageCount: 0 }),
    ).toBe(16_000);
    expect(computeHandoffAllowanceChars({ ...small, imageCount: 2 })).toBe(4 * (24_000 - 16_384));
    expect(computeHandoffAllowanceChars({ ...small, otherAttachmentCount: 6 })).toBe(0);
  });

  it("uses a 128k window when the target window is unknown", () => {
    expect(
      computeHandoffAllowanceChars({
        windowTokens: undefined,
        requestChars: 4 * 90_000,
        imageCount: 0,
        otherAttachmentCount: 0,
      }),
    ).toBe(4 * (128_000 - 32_000 - 90_000));
  });
});

describe("renderProviderHandoff", () => {
  it("selects by priority and renders chronologically before the raw request", () => {
    const messages = [
      message("u1", "user", "first user", 1),
      message("a1", "assistant", "x".repeat(3_000), 2),
      message("u2", "user", "y".repeat(3_000), 3),
      message("a2", "assistant", "latest reply", 4),
      message("u3", "user", "latest user", 5),
    ];
    const rendered = renderProviderHandoff({
      source: source(messages),
      userText: "Do the thing",
      allowanceChars: 1_000,
      participants,
    });
    expect(rendered.delivered).toBe(true);
    expect(rendered.messageIds).toEqual(["u1", "a2", "u3"]);
    expect(rendered.omittedCount).toBe(2);
    expect(rendered.input.startsWith(CONTEXT_HANDOFF_OPEN_TAG)).toBe(true);
    expect(rendered.input.endsWith("</f5-context-handoff>\n\nDo the thing")).toBe(true);
    expect(rendered.block).toContain("Included 3 of 5 messages; 2 omitted.");
    expect(rendered.block).toContain("handled by another agent (Claude · opus) until now");
    const order = ["first user", "latest reply", "latest user"].map((text) =>
      rendered.input.indexOf(text),
    );
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it("middle-truncates long messages without breaking surrogate pairs", () => {
    const long = "😀".repeat(10_000);
    const rendered = renderProviderHandoff({
      source: source([message("u1", "user", long, 1)]),
      userText: "next",
      allowanceChars: 32_000,
      participants,
    });
    expect(rendered.delivered).toBe(true);
    expect(rendered.block).toMatch(/…\[\d+ characters omitted\]…/);
    expect(rendered.block!.length).toBeLessThan(9_000);
    expect(rendered.block).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("counts fence escaping in the budget", () => {
    const fences = "```".repeat(300);
    const rendered = renderProviderHandoff({
      source: source([message("u1", "user", fences, 1), message("a1", "assistant", "ok", 2)]),
      userText: "next",
      allowanceChars: 1_000,
      participants,
    });
    // Escaped, the fenced message no longer fits; only the short reply does.
    expect(rendered.messageIds).toEqual(["a1"]);
    expect(rendered.block).not.toContain("``````");
  });

  it("caps the summary and drops messages before the summary at the input limit", () => {
    const rendered = renderProviderHandoff({
      source: source([message("u1", "user", "hello", 1)], "S".repeat(50_000)),
      userText: "next",
      allowanceChars: 30_000,
      participants,
    });
    expect(rendered.summaryIncluded).toBe(true);
    expect(rendered.block!.length).toBeLessThan(11_000);
  });

  it.each([120_000, 119_990, 119_500])(
    "never modifies or overflows a %i-character request",
    (chars) => {
      const userText = "q".repeat(chars);
      const rendered = renderProviderHandoff({
        source: source([message("u1", "user", "earlier", 1)]),
        userText,
        allowanceChars: 32_000,
        participants,
      });
      expect(rendered.input.trim().length).toBeLessThanOrEqual(120_000);
      expect(rendered.input.endsWith(userText)).toBe(true);
      if (chars > 119_500) {
        expect(rendered.delivered).toBe(false);
        expect(rendered.input).toBe(userText);
      }
    },
  );

  it("drops messages first to stay under the provider input limit", () => {
    const rendered = renderProviderHandoff({
      source: source([
        message("u1", "user", "a".repeat(5_000), 1),
        message("a1", "assistant", "b".repeat(5_000), 2),
      ]),
      userText: "q".repeat(112_000),
      allowanceChars: 32_000,
      participants,
    });
    expect(rendered.delivered).toBe(true);
    expect(rendered.messageIds).toEqual(["u1"]);
    expect(rendered.input.trim().length).toBeLessThanOrEqual(120_000);
  });

  it("drops the summary before the last message at the input limit", () => {
    const rendered = renderProviderHandoff({
      source: source([message("u1", "user", "short history", 1)], "S".repeat(20_000)),
      userText: "q".repeat(110_000),
      allowanceChars: 32_000,
      participants,
    });
    expect(rendered.delivered).toBe(true);
    expect(rendered.summaryIncluded).toBe(false);
    expect(rendered.messageIds).toEqual(["u1"]);
    expect(rendered.input.trim().length).toBeLessThanOrEqual(120_000);
  });

  it("retries without the summary when the summary leaves no room for any message", () => {
    const rendered = renderProviderHandoff({
      source: source([message("u1", "user", "x".repeat(1_400), 1)], "S".repeat(20_000)),
      userText: "next",
      allowanceChars: 1_500,
      participants,
    });
    expect(rendered.delivered).toBe(true);
    expect(rendered.summaryIncluded).toBe(false);
    expect(rendered.messageIds).toEqual(["u1"]);
  });

  it("hands off a summary alone only when compaction covered every message", () => {
    const summaryOnly = renderProviderHandoff({
      source: source([], "everything so far"),
      userText: "next",
      allowanceChars: 32_000,
      participants,
    });
    expect(summaryOnly.delivered).toBe(true);
    expect(summaryOnly.summaryIncluded).toBe(true);
    expect(summaryOnly.block).toContain("everything so far");
    expect(
      renderProviderHandoff({
        source: source([]),
        userText: "next",
        allowanceChars: 32_000,
        participants,
      }).delivered,
    ).toBe(false);
  });

  it("renders the delta sentence", () => {
    const rendered = renderProviderHandoff({
      source: { effectiveMode: "delta", messages: [message("u1", "user", "hi", 1)], summary: null },
      userText: "next",
      allowanceChars: 32_000,
      participants: { fromLabel: "Codex · gpt-5" },
    });
    expect(rendered.block).toContain("You worked on this conversation earlier");
  });
});

describe("composeHandoffInput", () => {
  it("keeps a user's Ultrathink keyword leading for Claude only", () => {
    expect(
      composeHandoffInput({
        block: "BLOCK",
        userText: "Ultrathink: plan it",
        targetProvider: "claudeAgent",
      }),
    ).toBe("Ultrathink:\nBLOCK\n\nplan it");
    expect(
      composeHandoffInput({
        block: "BLOCK",
        userText: "Ultrathink: plan it",
        targetProvider: "codex",
      }),
    ).toBe("BLOCK\n\nUltrathink: plan it");
    expect(
      composeHandoffInput({ block: "BLOCK", userText: "plan it", targetProvider: "claudeAgent" }),
    ).toBe("BLOCK\n\nplan it");
  });
});

describe("canResumeParkedSession", () => {
  const parked = {
    provider: "claudeAgent",
    cwd: "/repo",
    lastSeenMessageId: "a1",
    estimatedContextTokens: 10_000,
  };
  const base = {
    parked,
    desiredCwd: "/repo",
    threadMessageIds: new Set(["a1"]),
    deltaChars: 4_000,
    userTextChars: 400,
    targetWindowTokens: 200_000,
  };

  it("resumes when the checkout, last seen message and window all allow it", () => {
    expect(canResumeParkedSession(base)).toBe(true);
  });

  it("refuses a different checkout except for OpenCode", () => {
    expect(canResumeParkedSession({ ...base, desiredCwd: "/other" })).toBe(false);
    expect(
      canResumeParkedSession({
        ...base,
        desiredCwd: "/other",
        parked: { ...parked, provider: "opencode" },
      }),
    ).toBe(true);
  });

  it("refuses when a rewind removed the last seen message", () => {
    expect(canResumeParkedSession({ ...base, threadMessageIds: new Set() })).toBe(false);
  });

  it("refuses a context too full for the delta", () => {
    expect(canResumeParkedSession({ ...base, targetWindowTokens: 27_000 })).toBe(false);
    expect(canResumeParkedSession({ ...base, targetWindowTokens: null })).toBe(true);
  });
});
