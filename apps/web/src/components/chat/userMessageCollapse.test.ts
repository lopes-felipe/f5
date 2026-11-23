import { describe, expect, it } from "vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantResponseContext } from "@t3tools/shared/assistantResponseContext";

import {
  buildCollapsedUserMessageText,
  shouldCollapseUserMessage,
  USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD,
} from "./userMessageCollapse";

describe("userMessageCollapse", () => {
  it("keeps quote cards intact without spending the comment's character budget", () => {
    const card = serializeAssistantResponseContext({
      version: 1,
      kind: "quote",
      threadId: ThreadId.make("source"),
      messageId: MessageId.make("response"),
      text: "A long highlighted passage ".repeat(100),
    });
    expect(shouldCollapseUserMessage(card + "\n\nA short comment")).toBe(false);
    const longMessage = card + "\n\n" + "a".repeat(700);
    expect(shouldCollapseUserMessage(longMessage)).toBe(true);
    expect(buildCollapsedUserMessageText(longMessage)).toBe(card + "\n\n" + "a".repeat(600));
  });

  it("does not count the separators beside a card as comment lines", () => {
    const card = serializeAssistantResponseContext({
      version: 1,
      kind: "quote",
      threadId: ThreadId.make("source"),
      messageId: MessageId.make("response"),
      text: "Quoted",
    });
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => `line-${index}`).join("\n");
    // Displayed: the card, then eight comment lines.
    expect(shouldCollapseUserMessage(`${card}\n\n${lines(8)}`)).toBe(false);
    expect(shouldCollapseUserMessage(`${card}\n\n${lines(9)}`)).toBe(true);
    expect(buildCollapsedUserMessageText(`${card}\n\n${lines(9)}`)).toBe(`${card}\n\n${lines(8)}`);
    // A card between two texts starts a new line: one line before, the card, seven after.
    expect(shouldCollapseUserMessage(`intro\n\n${card}\n\n${lines(7)}`)).toBe(false);
    expect(buildCollapsedUserMessageText(`intro\n\n${card}\n\n${lines(8)}`)).toBe(
      `intro\n\n${card}\n\n${lines(7)}`,
    );
  });

  it("does not collapse empty text", () => {
    expect(shouldCollapseUserMessage("")).toBe(false);
    expect(buildCollapsedUserMessageText("")).toBe("");
  });

  it("does not collapse below or at the character threshold", () => {
    expect(shouldCollapseUserMessage("a".repeat(599))).toBe(false);
    expect(shouldCollapseUserMessage("a".repeat(600))).toBe(false);
  });

  it("collapses above the character threshold", () => {
    const text = "a".repeat(601);
    expect(shouldCollapseUserMessage(text)).toBe(true);
    expect(buildCollapsedUserMessageText(text)).toHaveLength(USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD);
  });

  it("does not collapse at the line threshold", () => {
    const text = Array.from({ length: 8 }, (_, index) => `line-${index}`).join("\n");
    expect(shouldCollapseUserMessage(text)).toBe(false);
  });

  it("collapses above the line threshold without a trailing newline", () => {
    const lines = Array.from({ length: 9 }, (_, index) => `line-${index}`);
    expect(shouldCollapseUserMessage(lines.join("\n"))).toBe(true);
    expect(buildCollapsedUserMessageText(lines.join("\n"))).toBe(lines.slice(0, 8).join("\n"));
  });

  it("collapses short text by line count", () => {
    const lines = Array.from({ length: 9 }, (_, index) => `l${index}`);
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD);
    expect(shouldCollapseUserMessage(text)).toBe(true);
  });

  it("collapses long single-line text by character count", () => {
    const text = "a".repeat(700);
    expect(shouldCollapseUserMessage(text)).toBe(true);
    expect(buildCollapsedUserMessageText(text)).toBe("a".repeat(600));
  });

  it("applies the character cap before the line cap", () => {
    const text = Array.from({ length: 12 }, (_, index) => `${index}-${"a".repeat(70)}`).join("\n");
    const firstSixHundred = text.slice(0, 600);
    expect(shouldCollapseUserMessage(text)).toBe(true);
    expect(buildCollapsedUserMessageText(text)).toBe(
      firstSixHundred.split("\n").slice(0, 8).join("\n"),
    );
  });
});
