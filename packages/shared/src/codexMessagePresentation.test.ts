import { describe, expect, it } from "vitest";
import { codexMessagePresentation, presentCodexMessageItem } from "./codexMessagePresentation";

describe("native Codex response presentation", () => {
  it("preserves old messages and explicitly visible answers", () => {
    expect(codexMessagePresentation({ text: "answer" })).toEqual({ replace: false });
    expect(
      codexMessagePresentation({ moderation: { display: { mode: "show", version: 1 } } }),
    ).toEqual({ replace: false, mode: "show" });
  });
  it.each(["hide", "block", "unknown"])("removes all answer copies for %s", (mode) => {
    const item = presentCodexMessageItem({
      id: "item",
      type: "agentMessage",
      text: "private",
      content: "private",
      questions: ["private"],
      moderation: { display: { mode, version: 1 } },
    });
    expect(JSON.stringify(item)).not.toContain("private");
    expect(item).toMatchObject({ id: "item", questions: null });
  });
  it("does not reveal content for unknown presentation versions", () => {
    expect(
      codexMessagePresentation({ moderation: { display: { mode: "show", version: 2 } } }).replace,
    ).toBe(true);
  });
  it("replaces provisional text with a recovered visible answer when native moderation changed it", () => {
    expect(
      codexMessagePresentation({
        text: "Recovered answer",
        moderation: { moderated: true, display: { mode: "show", version: 1 } },
      }),
    ).toEqual({ replace: true, mode: "show", text: "Recovered answer" });
  });
});
