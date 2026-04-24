import { describe, expect, it } from "vitest";

import {
  COMPOSER_SURROUND_PAIRS,
  doesSelectionTouchInlineToken,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });
});

describe("COMPOSER_SURROUND_PAIRS", () => {
  it("covers the expected ASCII and symmetric pairs", () => {
    expect(COMPOSER_SURROUND_PAIRS["("]).toEqual(["(", ")"]);
    expect(COMPOSER_SURROUND_PAIRS["["]).toEqual(["[", "]"]);
    expect(COMPOSER_SURROUND_PAIRS["{"]).toEqual(["{", "}"]);
    expect(COMPOSER_SURROUND_PAIRS["<"]).toEqual(["<", ">"]);
    expect(COMPOSER_SURROUND_PAIRS["«"]).toEqual(["«", "»"]);
    expect(COMPOSER_SURROUND_PAIRS["`"]).toEqual(["`", "`"]);
    expect(COMPOSER_SURROUND_PAIRS['"']).toEqual(['"', '"']);
    expect(COMPOSER_SURROUND_PAIRS["'"]).toEqual(["'", "'"]);
    expect(COMPOSER_SURROUND_PAIRS["*"]).toEqual(["*", "*"]);
    expect(COMPOSER_SURROUND_PAIRS["_"]).toEqual(["_", "_"]);
  });
});

describe("doesSelectionTouchInlineToken", () => {
  it("returns false for collapsed selections", () => {
    expect(doesSelectionTouchInlineToken("hello @path world", 3, 3)).toBe(false);
  });

  it("returns false when the selection is entirely within plain text", () => {
    // Prompt: "hello @path world"
    //         0         1
    //         0123456789012345678
    // Select "hello" -> [0, 5)
    expect(doesSelectionTouchInlineToken("hello @path world", 0, 5)).toBe(false);
  });

  it("detects a mention fully contained in the selection", () => {
    // Select "@path" -> [6, 11)
    expect(doesSelectionTouchInlineToken("hello @path world", 6, 11)).toBe(true);
  });

  it("detects a mention partially overlapped by the selection", () => {
    // Select "lo @pa" -> [3, 9)
    expect(doesSelectionTouchInlineToken("hello @path world", 3, 9)).toBe(true);
  });

  it("detects a selection that abuts the end of a mention", () => {
    // Select " world" right after "@path" -> [11, 17), mention ends at 11
    expect(doesSelectionTouchInlineToken("hello @path world", 11, 17)).toBe(true);
  });

  it("detects a selection that abuts the start of a mention", () => {
    // Select "hello " ending right where "@path" begins at index 6 -> [0, 6)
    expect(doesSelectionTouchInlineToken("hello @path world", 0, 6)).toBe(true);
  });

  it("detects a terminal context placeholder inside the selection", () => {
    const prompt = `a ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} b`;
    // Select the placeholder
    expect(doesSelectionTouchInlineToken(prompt, 2, 3)).toBe(true);
  });

  it("detects a selection that abuts a terminal context placeholder", () => {
    const prompt = `a${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}b`;
    // Select only "a" which ends at the placeholder start (index 1)
    expect(doesSelectionTouchInlineToken(prompt, 0, 1)).toBe(true);
  });

  it("normalizes reversed selections", () => {
    expect(doesSelectionTouchInlineToken("hello @path world", 11, 6)).toBe(true);
  });
});
