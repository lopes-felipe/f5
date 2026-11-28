import type { MobileBatch, MobileMessagePatch } from "@t3tools/contracts/mobile/v1";
import { describe, expect, it } from "vitest";
import { applyMessageBatch, mergeHistory, type Detail } from "./model";

const createdAt = "2026-11-28T00:00:00.000Z";
const detail: Detail = {
  snapshotSequence: 5,
  messages: [
    { messageId: "message", text: "Hello", role: "assistant", streaming: true, createdAt },
  ],
  approvals: [],
  pendingInputs: [],
  plan: null,
  activity: [],
  cursor: null,
};
function batch(messages: readonly (typeof MobileMessagePatch.Type)[]): typeof MobileBatch.Type {
  return {
    afterSequence: 4,
    throughSequence: 9,
    threadIds: [],
    projectsChanged: false,
    selectedThreadId: "thread",
    messages,
    tailInvalidated: false,
    transcriptReset: false,
  };
}
const patch = (sequence: number, text: string, mode: "append" | "replace" = "append") => ({
  sequence,
  messageId: "message",
  createdAt,
  role: "assistant",
  text,
  mode,
  completed: false,
  streaming: true,
});

describe("mobile timeline", () => {
  it("uses the message cursor inside a batch that overlaps a snapshot", () => {
    const result = applyMessageBatch(detail, batch([patch(5, "Hello"), patch(6, " world")]));
    expect(result.detail.messages[0]?.text).toBe("Hello world");
    expect(result.needsTail).toBe(false);
  });

  it("handles replace and completion without clearing text", () => {
    const result = applyMessageBatch(
      detail,
      batch([
        patch(6, "replacement", "replace"),
        { ...patch(7, ""), streaming: false, completed: true },
      ]),
    );
    expect(result.detail.messages[0]?.text).toBe("replacement");
    expect(result.detail.messages[0]?.streaming).toBe(false);
    expect(result.needsTail).toBe(true);
  });

  it("keeps oversized live text bounded and never appends after the truncation notice", () => {
    const oversized = applyMessageBatch(detail, batch([patch(6, "😀".repeat(20_000))]));
    const message = oversized.detail.messages[0]!;
    expect(message.truncated).toBe(true);
    expect(message.text).toMatch(/\[Open on the host for the full text\]$/);
    const reconnected = applyMessageBatch(
      { ...oversized.detail, snapshotSequence: 5 },
      batch([patch(7, "continuing")]),
    );
    expect(reconnected.detail.messages[0]?.text).toBe(message.text);
    const replacement = applyMessageBatch(
      { ...reconnected.detail, snapshotSequence: 5 },
      batch([patch(8, "replacement", "replace")]),
    );
    expect(replacement.detail.messages[0]).toMatchObject({ text: "replacement" });
    expect(replacement.detail.messages[0]?.truncated).toBeUndefined();
  });

  it("keeps live text when an older page overlaps and caps the retained window", () => {
    const oldMessages = Array.from({ length: 510 }, (_, i) => ({
      ...detail.messages[0]!,
      text: String(i),
      messageId: String(i),
      createdAt: "2026-11-27T00:00:00.000Z",
    }));
    const overlap = { ...detail.messages[0]!, text: "stale" };
    const merged = mergeHistory(detail, {
      snapshotSequence: 4,
      messages: [...oldMessages, overlap],
      cursor: { createdAt, messageId: "older" },
    });
    expect(merged.messages).toHaveLength(500);
    expect(merged.messages.at(-1)?.text).toBe("Hello");
    expect(merged.cursor).toBeNull();
  });
});
