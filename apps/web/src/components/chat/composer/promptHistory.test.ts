import { describe, expect, it } from "vitest";
import { appendAttachedFilesToPrompt } from "~/lib/attachedFiles";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerSendText";
import { stepPromptHistory, recallablePrompt } from "./promptHistory";

const messages = [
  { id: "u1", role: "user", text: "first" },
  { id: "a1", role: "assistant", text: "not recalled" },
  { id: "u2", role: "user", text: "second" },
];
describe("thread prompt recall", () => {
  it("skips automation, agent and server submissions in both directions", () => {
    const authoredMessages = [
      { id: "typed", role: "user", text: "typed", authorship: "human" },
      { id: "scheduled", role: "user", text: "scheduled", authorship: "automation" },
      { id: "agent", role: "user", text: "agent prompt", authorship: "automation" },
      { id: "server", role: "user", text: "continue", authorship: "automation" },
    ] as const;
    const recalled = stepPromptHistory({
      threadId: "a",
      messages: authoredMessages,
      position: null,
      prompt: "",
      direction: "up",
    })!;
    expect(recalled.prompt).toBe("typed");
    expect(
      stepPromptHistory({
        threadId: "a",
        messages: authoredMessages,
        ...recalled,
        direction: "down",
      }),
    ).toEqual({ prompt: "", position: null });
    expect(
      stepPromptHistory({
        threadId: "a",
        messages: authoredMessages.slice(1),
        position: null,
        prompt: "",
        direction: "up",
      }),
    ).toBeNull();
  });
  it("walks back, forward, and back to the empty draft", () => {
    const last = stepPromptHistory({
      threadId: "a",
      messages,
      position: null,
      prompt: "",
      direction: "up",
    })!;
    expect(last.prompt).toBe("second");
    const first = stepPromptHistory({ threadId: "a", messages, ...last, direction: "up" })!;
    expect(first.prompt).toBe("first");
    const second = stepPromptHistory({ threadId: "a", messages, ...first, direction: "down" })!;
    expect(second.prompt).toBe("second");
    expect(stepPromptHistory({ threadId: "a", messages, ...second, direction: "down" })).toEqual({
      prompt: "",
      position: null,
    });
  });
  it("does not overwrite edited text or carry a position to another thread", () => {
    const recalled = stepPromptHistory({
      threadId: "a",
      messages,
      position: null,
      prompt: "",
      direction: "up",
    })!;
    expect(
      stepPromptHistory({
        threadId: "a",
        messages,
        ...recalled,
        prompt: "edited",
        direction: "up",
      }),
    ).toBeNull();
    expect(stepPromptHistory({ threadId: "b", messages, ...recalled, direction: "up" })).toBeNull();
  });
  it("removes send-time file context but preserves ordinary user text", () => {
    expect(recallablePrompt(appendAttachedFilesToPrompt("  explain this", ["/old/file"]))).toBe(
      "  explain this",
    );
    expect(recallablePrompt(IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(recallablePrompt("literal <attached_files> example")).toBe(
      "literal <attached_files> example",
    );
  });
});
