import { describe, expect, it } from "vitest";

import {
  handoffableMessages,
  hasHandoffableConversation,
  stripContextHandoffBlocks,
} from "./conversationHandoff";

const message = (id: string, role: string, text: string, createdAt: string, streaming = false) => ({
  id,
  role,
  text,
  createdAt,
  streaming,
});

describe("conversationHandoff", () => {
  const messages = [
    message("b", "assistant", "reply", "2026-10-01T00:00:01.000Z"),
    message("a", "user", "hello", "2026-10-01T00:00:01.000Z"),
    message("c", "system", "note", "2026-10-01T00:00:02.000Z"),
    message("d", "assistant", "   ", "2026-10-01T00:00:03.000Z"),
    message("e", "assistant", "partial", "2026-10-01T00:00:04.000Z", true),
    message(
      "f",
      "user",
      "<f5-context-handoff v1>\nold\n</f5-context-handoff>",
      "2026-10-01T00:00:05.000Z",
    ),
  ];

  it("keeps settled user and assistant text ordered by createdAt then id", () => {
    expect(handoffableMessages(messages).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(handoffableMessages(messages, "b").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("stops at the triggering message so later submissions are not history yet", () => {
    const thread = [
      message("past", "user", "earlier", "2026-10-01T00:00:01.000Z"),
      message("future", "user", "queued after", "2026-10-01T00:00:03.000Z"),
      message("trigger", "user", "now", "2026-10-01T00:00:02.000Z"),
    ];
    expect(handoffableMessages(thread, "trigger").map((entry) => entry.id)).toEqual(["past"]);
    expect(hasHandoffableConversation(thread.slice(1), "trigger")).toBe(false);
    // An unknown trigger only excludes itself.
    expect(handoffableMessages(thread, "gone").map((entry) => entry.id)).toEqual([
      "past",
      "trigger",
      "future",
    ]);
  });

  it("agrees with the boolean predicate", () => {
    expect(hasHandoffableConversation(messages)).toBe(true);
    expect(hasHandoffableConversation(messages.slice(2))).toBe(false);
    expect(hasHandoffableConversation([messages[1]!], "a")).toBe(false);
  });

  it("strips an earlier rendered handoff block only where the renderer puts it", () => {
    expect(
      stripContextHandoffBlocks("<f5-context-handoff v1>\nx\n</f5-context-handoff>\n\nkeep").trim(),
    ).toBe("keep");
    expect(
      stripContextHandoffBlocks(
        "Ultrathink:\n<f5-context-handoff v1>\nx\n</f5-context-handoff>\n\nkeep",
      ).replace(/\s+/g, " "),
    ).toBe("Ultrathink: keep");
    const quoted = "Why does `<f5-context-handoff v1>` pair with `</f5-context-handoff>`?";
    expect(stripContextHandoffBlocks(quoted)).toBe(quoted);
  });
});
