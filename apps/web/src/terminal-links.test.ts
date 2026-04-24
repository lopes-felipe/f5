import { describe, expect, it } from "vitest";

import {
  assembleWrappedLogicalLine,
  extractTerminalLinks,
  extractWrappedTerminalLinks,
  isTerminalLinkActivation,
  mapLogicalRangeToPhysical,
  resolvePathLinkTarget,
  splitPathAndPosition,
  type WrappedTerminalBufferLike,
} from "./terminal-links";

// Minimal stub mirroring the subset of xterm's IBuffer/IBufferLine surface we
// depend on. Each row is stored as a fixed-width string that matches `cols`
// padding, exactly like xterm's on-screen buffer.
function buildWrappedBuffer(
  rows: ReadonlyArray<{ text: string; isWrapped: boolean }>,
  cols: number,
): WrappedTerminalBufferLike {
  return {
    getLine(y: number) {
      const row = rows[y];
      if (!row) return null;
      const padded = row.text.padEnd(cols, " ").slice(0, cols);
      return {
        isWrapped: row.isWrapped,
        translateToString(trimRight = false) {
          return trimRight ? padded.trimEnd() : padded;
        },
      };
    },
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line =
      "failed at https://example.com/docs and src/components/ThreadTerminalDrawer.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalDrawer.tsx:42",
        start: 39,
        end: 81,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("does not treat file URIs as filesystem path links", () => {
    expect(extractTerminalLinks("file:///etc/passwd")).toEqual([]);
    expect(extractTerminalLinks("file:/Users/julius/project/src/main.ts")).toEqual([]);
  });
});

describe("resolvePathLinkTarget", () => {
  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget(
        "src/components/ThreadTerminalDrawer.tsx:42:7",
        "/Users/julius/project",
      ),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalDrawer.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });
});

describe("splitPathAndPosition", () => {
  it("splits path, line, and column suffixes", () => {
    expect(splitPathAndPosition("src/main.ts:42:7")).toEqual({
      path: "src/main.ts",
      line: "42",
      column: "7",
    });
    expect(splitPathAndPosition("src/main.ts:42")).toEqual({
      path: "src/main.ts",
      line: "42",
      column: undefined,
    });
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });
});

describe("assembleWrappedLogicalLine", () => {
  it("concatenates contiguous wrapped rows", () => {
    const cols = 10;
    const buffer = buildWrappedBuffer(
      [
        { text: "hello xxxx", isWrapped: false },
        { text: "world yyyy", isWrapped: true },
      ],
      cols,
    );
    const logical = assembleWrappedLogicalLine(buffer, 1);
    expect(logical.startY).toBe(0);
    expect(logical.endY).toBe(1);
    expect(logical.text).toBe("hello xxxxworld yyyy");
  });

  it("stops at the first non-wrapped boundary above and below", () => {
    const cols = 8;
    const buffer = buildWrappedBuffer(
      [
        { text: "first   ", isWrapped: false },
        { text: "second  ", isWrapped: false },
        { text: "suffix  ", isWrapped: true },
        { text: "third   ", isWrapped: false },
      ],
      cols,
    );
    const logical = assembleWrappedLogicalLine(buffer, 2);
    expect(logical.startY).toBe(1);
    expect(logical.endY).toBe(2);
    expect(logical.text).toBe("second  suffix  ");
  });
});

describe("mapLogicalRangeToPhysical", () => {
  it("maps a range contained within a single row", () => {
    expect(mapLogicalRangeToPhysical(3, 2, 7, 10)).toEqual({
      startY: 3,
      startX: 2,
      endY: 3,
      endX: 7,
    });
  });

  it("maps a range that straddles a row boundary", () => {
    // cols = 10, start = 7 -> row 0 col 7, end = 15 -> last char at row 1 col 4 (exclusive col 5)
    expect(mapLogicalRangeToPhysical(0, 7, 15, 10)).toEqual({
      startY: 0,
      startX: 7,
      endY: 1,
      endX: 5,
    });
  });

  it("maps a range that ends exactly at a row boundary", () => {
    // cols = 10, end = 10 -> last char row 0 col 9 (inclusive) -> endX = 10
    expect(mapLogicalRangeToPhysical(2, 0, 10, 10)).toEqual({
      startY: 2,
      startX: 0,
      endY: 2,
      endX: 10,
    });
  });
});

describe("extractWrappedTerminalLinks", () => {
  it("recovers a URL that wraps across two rows", () => {
    const cols = 20;
    // URL: https://example.com/docs/page.html (34 chars)
    // row 0: "see https://example." (20 chars, wrapped continues on next row)
    // row 1: "com/docs/page.html  " (20 chars, last)
    const buffer = buildWrappedBuffer(
      [
        { text: "see https://example.", isWrapped: false },
        { text: "com/docs/page.html  ", isWrapped: true },
      ],
      cols,
    );

    const fromFirstRow = extractWrappedTerminalLinks(buffer, 0, cols);
    expect(fromFirstRow).toHaveLength(1);
    expect(fromFirstRow[0]?.kind).toBe("url");
    expect(fromFirstRow[0]?.text).toBe("https://example.com/docs/page.html");
    expect(fromFirstRow[0]?.physical).toEqual({
      startY: 0,
      startX: 4,
      endY: 1,
      endX: 18,
    });

    // Hovering the continuation row should surface the same link entry so the
    // Cmd/Ctrl-click hit-box remains intact all the way through.
    const fromSecondRow = extractWrappedTerminalLinks(buffer, 1, cols);
    expect(fromSecondRow).toHaveLength(1);
    expect(fromSecondRow[0]?.text).toBe("https://example.com/docs/page.html");
    expect(fromSecondRow[0]?.physical.startY).toBe(0);
    expect(fromSecondRow[0]?.physical.endY).toBe(1);
  });

  it("recovers a URL that wraps across three rows", () => {
    const cols = 10;
    // URL length = 25: "https://example.com/a/b/c"
    // row 0: "xxhttps://" (10 chars) wrapped continues
    // row 1: "example.co" (10 chars) wrapped continues
    // row 2: "m/a/b/c   " (10 chars, last)
    const buffer = buildWrappedBuffer(
      [
        { text: "xxhttps://", isWrapped: false },
        { text: "example.co", isWrapped: true },
        { text: "m/a/b/c   ", isWrapped: true },
      ],
      cols,
    );
    const matches = extractWrappedTerminalLinks(buffer, 0, cols);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("https://example.com/a/b/c");
    expect(matches[0]?.physical).toEqual({
      startY: 0,
      startX: 2,
      endY: 2,
      endX: 7,
    });
  });

  it("handles a URL that starts mid-row", () => {
    const cols = 20;
    const buffer = buildWrappedBuffer(
      [
        { text: "error at https://exa", isWrapped: false },
        { text: "mple.com/page       ", isWrapped: true },
      ],
      cols,
    );
    const matches = extractWrappedTerminalLinks(buffer, 0, cols);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.text).toBe("https://example.com/page");
    expect(matches[0]?.physical.startY).toBe(0);
    expect(matches[0]?.physical.startX).toBe(9);
  });

  it("does not merge adjacent non-wrapped URLs on the next line", () => {
    const cols = 20;
    const buffer = buildWrappedBuffer(
      [
        { text: "https://a.example   ", isWrapped: false },
        // Second line is NOT a wrap of the first — separate logical line.
        { text: "https://b.example   ", isWrapped: false },
      ],
      cols,
    );
    const row0 = extractWrappedTerminalLinks(buffer, 0, cols);
    const row1 = extractWrappedTerminalLinks(buffer, 1, cols);

    expect(row0.map((match) => match.text)).toEqual(["https://a.example"]);
    expect(row1.map((match) => match.text)).toEqual(["https://b.example"]);
    // Each match should stay confined to its own row.
    expect(row0[0]?.physical.startY).toBe(0);
    expect(row0[0]?.physical.endY).toBe(0);
    expect(row1[0]?.physical.startY).toBe(1);
    expect(row1[0]?.physical.endY).toBe(1);
  });
});
