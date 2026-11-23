import { describe, expect, it } from "vitest";

import {
  ansi256Color,
  applySgr,
  escapeSafeCutIndex,
  hasAnsiEscapes,
  parseAnsiOutput,
  stripAnsi,
} from "./ansiOutput";

describe("parseAnsiOutput", () => {
  it("styles text with 16-color SGR and resets", () => {
    const parsed = parseAnsiOutput("\x1b[1;31mFAIL\x1b[0m src/a.test.ts\n\x1b[32m✓\x1b[39m ok");
    expect(parsed.text).toBe("FAIL src/a.test.ts\n✓ ok");
    expect(parsed.lines).toEqual([
      [
        { text: "FAIL", style: { bold: true, fg: { kind: "palette", index: 1 } } },
        { text: " src/a.test.ts", style: null },
      ],
      [
        { text: "✓", style: { fg: { kind: "palette", index: 2 } } },
        { text: " ok", style: null },
      ],
    ]);
  });

  it("carries styles across lines and reads bright, 256 and truecolor", () => {
    const parsed = parseAnsiOutput("\x1b[93ma\nb\x1b[38;5;196mc\x1b[48;2;1;2;3md");
    expect(parsed.lines[0]).toEqual([{ text: "a", style: { fg: { kind: "palette", index: 11 } } }]);
    expect(parsed.lines[1]).toEqual([
      { text: "b", style: { fg: { kind: "palette", index: 11 } } },
      { text: "c", style: { fg: { kind: "rgb", value: "#ff0000" } } },
      {
        text: "d",
        style: { fg: { kind: "rgb", value: "#ff0000" }, bg: { kind: "rgb", value: "#010203" } },
      },
    ]);
  });

  it("drops cursor, erase and OSC sequences", () => {
    const raw = "\x1b[2K\x1b[1Gdone \x1b]8;;https://x.test\x07link\x1b]8;;\x07\x1b[?25h";
    expect(parseAnsiOutput(raw).text).toBe("done link");
    expect(stripAnsi(raw)).toBe("done link");
  });

  it("drops charset selection and ends a cut-off OSC at the line break", () => {
    expect(stripAnsi("\x1b[1mbold\x1b(B\x1b[m rest")).toBe("bold rest");
    expect(parseAnsiOutput("a\x1b]8;;https://x.test\nnext line").text).toBe("a\nnext line");
    expect(hasAnsiEscapes("\x1b(B")).toBe(true);
  });

  it("drops DCS, SOS, PM and APC strings with their payload", () => {
    expect(stripAnsi("before\x1bP$qm\x1b\\after")).toBe("beforeafter");
    expect(stripAnsi("a\x1b_payload\x1b\\b\x1b^pm\x1b\\c\x1bXsos\x1b\\d")).toBe("abcd");
    expect(parseAnsiOutput("x\x1bPcut off\nnext").text).toBe("x\nnext");
  });

  it("keeps colon-form color subparameters together", () => {
    expect(applySgr({}, "38:2::10:20:1")).toEqual({ fg: { kind: "rgb", value: "#0a1401" } });
    expect(applySgr({}, "38:2:10:20:1")).toEqual({ fg: { kind: "rgb", value: "#0a1401" } });
    expect(applySgr({}, "48:5:196;1")).toEqual({
      bg: { kind: "rgb", value: "#ff0000" },
      bold: true,
    });
    // The legacy semicolon form still works, with a following attribute.
    expect(applySgr({}, "38;2;10;20;1;4")).toEqual({
      fg: { kind: "rgb", value: "#0a1401" },
      underline: true,
    });
  });

  it("finds cut points outside escape sequences", () => {
    const text = "ab\x1b[31mred\x1b[0m";
    // A cut inside `\x1b[31m` moves to its start (end of text) or past it (start of text).
    expect(escapeSafeCutIndex(text, 4, "end")).toBe(2);
    expect(escapeSafeCutIndex(text, 4, "start")).toBe(7);
    expect(escapeSafeCutIndex(text, 8, "start")).toBe(8);
    expect(escapeSafeCutIndex("plain text", 4, "start")).toBe(4);
  });

  it("toggles attributes off", () => {
    let style = applySgr({}, "1;2;3;4");
    expect(style).toEqual({ bold: true, dim: true, italic: true, underline: true });
    style = applySgr(style, "22;23;24");
    expect(style).toEqual({});
    expect(applySgr({ fg: { kind: "palette", index: 1 } }, "")).toEqual({});
  });

  it("maps the 256-color cube and grayscale ramp", () => {
    expect(ansi256Color(4)).toEqual({ kind: "palette", index: 4 });
    expect(ansi256Color(16)).toEqual({ kind: "rgb", value: "#000000" });
    expect(ansi256Color(231)).toEqual({ kind: "rgb", value: "#ffffff" });
    expect(ansi256Color(232)).toEqual({ kind: "rgb", value: "#080808" });
    expect(ansi256Color(300)).toBeNull();
  });

  it("detects escapes", () => {
    expect(hasAnsiEscapes("plain")).toBe(false);
    expect(hasAnsiEscapes("\x1b[0m")).toBe(true);
  });
});
