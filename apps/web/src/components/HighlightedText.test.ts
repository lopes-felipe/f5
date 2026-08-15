import { describe, expect, it } from "vitest";

import { buildHighlightedTextSegments } from "./HighlightedText";

describe("buildHighlightedTextSegments", () => {
  it("highlights query terms case-insensitively", () => {
    expect(
      buildHighlightedTextSegments({ text: "Reconnect after retry", query: "retry reconnect" }),
    ).toEqual([
      { text: "Reconnect", highlighted: true },
      { text: " after ", highlighted: false },
      { text: "retry", highlighted: true },
    ]);
  });

  it("applies exact ranges as code-point offsets", () => {
    expect(
      buildHighlightedTextSegments({
        text: "A😀BC",
        ranges: [{ start: 1, end: 3 }],
      }),
    ).toEqual([
      { text: "A", highlighted: false },
      { text: "😀B", highlighted: true },
      { text: "C", highlighted: false },
    ]);
  });

  it("merges overlapping and out-of-bounds ranges", () => {
    expect(
      buildHighlightedTextSegments({
        text: "abcdef",
        ranges: [
          { start: -2, end: 2 },
          { start: 1, end: 4 },
          { start: 5, end: 20 },
        ],
      }),
    ).toEqual([
      { text: "abcd", highlighted: true },
      { text: "e", highlighted: false },
      { text: "f", highlighted: true },
    ]);
  });
});
