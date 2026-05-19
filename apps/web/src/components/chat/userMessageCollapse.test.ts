import { describe, expect, it } from "vitest";

import {
  buildCollapsedUserMessageText,
  shouldCollapseUserMessage,
  USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD,
} from "./userMessageCollapse";

describe("userMessageCollapse", () => {
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
