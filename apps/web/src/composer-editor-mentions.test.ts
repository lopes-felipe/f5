import { describe, expect, it } from "vitest";
import {
  collectComposerMentionPaths,
  createComposerMention,
  doesSelectionTouchInlineToken,
  normalizeComposerMentions,
  reconcileComposerMentions,
  replaceComposerMentionRange,
  serializeComposerMentionPath,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("explicit composer mentions", () => {
  it.each([
    "@creditornot/wolt-auth",
    "@scope/package",
    "@alice.name",
    "alice@example.com",
    '@"src/main.ts"',
    "@src/main.ts",
    "@alice",
  ])("never infers a mention from typed or pasted %s", (literal) => {
    for (const suffix of ["", " ", "\n", " please"]) {
      const prompt = "Use " + literal + suffix;
      expect(collectComposerMentionPaths(prompt)).toEqual([]);
      expect(splitPromptIntoComposerSegments(prompt)).toEqual([{ type: "text", text: prompt }]);
      expect(doesSelectionTouchInlineToken(prompt, 0, prompt.length)).toBe(false);
    }
  });

  it.each([
    "src/index.ts",
    "Makefile",
    "src",
    "docs/My File.md",
    'docs/My "File".md',
    "@scope/file.ts",
  ])("round trips an explicitly selected %s, including at the end of a prompt", (path) => {
    const raw = "@" + serializeComposerMentionPath(path);
    const prompt = "Read " + raw;
    const mention = createComposerMention(path, 5);
    expect(collectComposerMentionPaths(prompt, [mention])).toEqual([path]);
    expect(splitPromptIntoComposerSegments(prompt, [], [mention])).toEqual([
      { type: "text", text: "Read " },
      { type: "mention", id: mention.id, path, raw },
    ]);
    expect(doesSelectionTouchInlineToken(prompt, 5, prompt.length, [mention])).toBe(true);
    expect(doesSelectionTouchInlineToken(prompt, 5, 5, [mention])).toBe(false);
  });

  it("tracks each occurrence separately even when literal text is identical", () => {
    const prompt = "@src/a.ts @src/a.ts";
    const mention = createComposerMention("src/a.ts", 10);
    expect(splitPromptIntoComposerSegments(prompt, [], [mention])).toEqual([
      { type: "text", text: "@src/a.ts " },
      { type: "mention", id: mention.id, path: "src/a.ts", raw: "@src/a.ts" },
    ]);
    expect(collectComposerMentionPaths(prompt, [mention])).toEqual(["src/a.ts"]);
  });

  it("retains offsets around terminal placeholders", () => {
    const prompt = "a" + INLINE_TERMINAL_CONTEXT_PLACEHOLDER + "@src/a.ts";
    const mention = createComposerMention("src/a.ts", 2);
    expect(splitPromptIntoComposerSegments(prompt, [], [mention])).toEqual([
      { type: "text", text: "a" },
      { type: "terminal-context", context: null },
      { type: "mention", id: mention.id, path: "src/a.ts", raw: "@src/a.ts" },
    ]);
    expect(doesSelectionTouchInlineToken(prompt, 0, 1)).toBe(true);
    expect(doesSelectionTouchInlineToken(prompt, prompt.length, 2, [mention])).toBe(true);
  });

  it("rejects stale, malformed, overlapping and duplicate metadata", () => {
    const prompt = "@src/a.ts @src/a.ts";
    const mention = createComposerMention("src/a.ts", 0);
    expect(
      normalizeComposerMentions(prompt, [
        null,
        {},
        { ...mention, start: -1 },
        { ...mention, end: 300 },
        { ...mention, path: "src/b.ts" },
        mention,
        { ...mention, id: "overlap" },
        { ...mention, start: 10, end: 19 },
      ]),
    ).toEqual([mention]);
    expect(normalizeComposerMentions(prompt, undefined)).toEqual([]);
  });
});

describe("mention edits", () => {
  const prompt = "Read @src/a.ts please";
  const mention = createComposerMention("src/a.ts", 5);

  it("uses the input selection when identical literal text replaces a mention", () => {
    expect(
      reconcileComposerMentions(prompt, prompt, [mention], {
        start: mention.start,
        end: mention.end,
      }),
    ).toEqual([]);
    expect(
      reconcileComposerMentions(prompt, prompt, [mention], {
        start: 0,
        end: 4,
      }),
    ).toEqual([mention]);
  });

  it("shifts occurrences when text is inserted or removed before them", () => {
    expect(reconcileComposerMentions(prompt, "Now " + prompt, [mention])).toEqual([
      { ...mention, start: 9, end: mention.end + 4 },
    ]);
    expect(reconcileComposerMentions(prompt, prompt.slice(5), [mention])).toEqual([
      { ...mention, start: 0, end: mention.end - 5 },
    ]);
  });

  it("preserves occurrences for edits after them, including removal of trailing space", () => {
    expect(reconcileComposerMentions(prompt, prompt.slice(0, mention.end), [mention])).toEqual([
      mention,
    ]);
    expect(reconcileComposerMentions(prompt, prompt + "!", [mention])).toEqual([mention]);
  });

  it("invalidates mentions edited within their spans or replaced entirely", () => {
    expect(reconcileComposerMentions(prompt, prompt.replace("a.ts", "b.ts"), [mention])).toEqual(
      [],
    );
    expect(reconcileComposerMentions(prompt, "Read please", [mention])).toEqual([]);
    expect(replaceComposerMentionRange([mention], mention.start, mention.end, 9)).toEqual([]);
    expect(replaceComposerMentionRange([mention], mention.start + 1, mention.start + 1, 1)).toEqual(
      [],
    );
  });

  it("preserves boundary insertions without extending the selected occurrence", () => {
    expect(replaceComposerMentionRange([mention], mention.end, mention.end, 4)).toEqual([mention]);
    expect(replaceComposerMentionRange([mention], mention.start, mention.start, 4)).toEqual([
      { ...mention, start: mention.start + 4, end: mention.end + 4 },
    ]);
  });
});
