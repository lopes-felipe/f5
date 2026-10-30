import { describe, expect, it } from "vitest";
import { buildCollapsedUserMessageText } from "../components/chat/userMessageCollapse";
import {
  clipUserMessageSegments,
  hasUserMessageMarkup,
  parseUserMessageMarkup,
  type UserMessageSegment,
} from "./userMessageMarkup";

const summarize = (segments: readonly UserMessageSegment[]) =>
  segments.map((segment) =>
    segment.kind === "text"
      ? ["text", segment.raw]
      : segment.kind === "thread-reference"
        ? [segment.kind, segment.threadId]
        : [segment.kind, segment.value],
  );

const rawOf = (segments: readonly UserMessageSegment[]) =>
  segments.map((segment) => segment.raw).join("");

describe("parseUserMessageMarkup", () => {
  it("parses code spans, double-backtick spans and bold", () => {
    const text = "Run `bun test` and ``a ` b`` then **really** do it";
    const segments = parseUserMessageMarkup(text);
    expect(summarize(segments)).toEqual([
      ["text", "Run "],
      ["code", "bun test"],
      ["text", " and "],
      ["code", "a ` b"],
      ["text", " then "],
      ["bold", "really"],
      ["text", " do it"],
    ]);
    expect(rawOf(segments)).toBe(text);
  });

  it.each([
    "__init__",
    "snake_case",
    "*.ts and *.tsx",
    "~~x~~",
    String.raw`\`not code\``,
    "a**b**c",
    "# Heading\n- item",
  ])("keeps %s literal", (text) => {
    const segments = parseUserMessageMarkup(text);
    expect(hasUserMessageMarkup(segments)).toBe(false);
    expect(rawOf(segments)).toBe(text);
  });

  it("parses closed fences and respects marker type and length", () => {
    const text = "Before\n````ts\n```\ninner\n````\nAfter ~~~ text\n~~~\nx\n~~~";
    const segments = parseUserMessageMarkup(text);
    expect(summarize(segments)).toEqual([
      ["text", "Before\n"],
      ["codeblock", "```\ninner"],
      ["text", "After ~~~ text\n"],
      ["codeblock", "x"],
    ]);
    expect(rawOf(segments)).toBe(text);
  });

  it("does not close a backtick fence with tildes and keeps an unclosed fence literal", () => {
    const text = "```\ncode\n~~~\nmore";
    expect(hasUserMessageMarkup(parseUserMessageMarkup(text))).toBe(false);
    expect(rawOf(parseUserMessageMarkup(text))).toBe(text);
  });

  it("does not let a code span cross a blank line", () => {
    expect(hasUserMessageMarkup(parseUserMessageMarkup("a `b\n\nc` d"))).toBe(false);
    expect(hasUserMessageMarkup(parseUserMessageMarkup("a **b\n\nc** d"))).toBe(false);
    expect(parseUserMessageMarkup("x\n\na `b` and **c** d")).toMatchObject([
      { kind: "text", raw: "x\n\na " },
      { kind: "code", value: "b" },
      { kind: "text", raw: " and " },
      { kind: "bold", value: "c" },
      { kind: "text", raw: " d" },
    ]);
  });

  it("matches a backtick closer of the same length only, skipping other runs", () => {
    expect(parseUserMessageMarkup("``a ` b`` c")).toMatchObject([
      { kind: "code", value: "a ` b" },
      { kind: "text", raw: " c" },
    ]);
  });

  // Parsing runs during render on messages up to 120k characters; unclosed
  // openers must not rescan the rest of the message.
  it.each([
    ["unclosed fences", "```ts\n".repeat(20_000)],
    [
      "unclosed tilde fences of growing length",
      Array.from({ length: 2_000 }, (_, i) => "~".repeat(3 + (i % 50))).join("\n"),
    ],
    ["unclosed bold", "**a ".repeat(30_000)],
    ["unclosed code spans", "`a ".repeat(40_000)],
    ["mixed backtick runs", "`` a ` ".repeat(17_000)],
  ])("parses adversarial %s in linear time", (_name, text) => {
    const started = performance.now();
    const segments = parseUserMessageMarkup(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rawOf(segments)).toBe(text);
  });

  it("keeps backticks and bold markers inside a thread reference title atomic", () => {
    const text = "See [Fix `parser` **now**](f5://thread/thread-1) and `code`";
    const segments = parseUserMessageMarkup(text);
    expect(segments[1]).toMatchObject({
      kind: "thread-reference",
      threadId: "thread-1",
      label: "Fix `parser` **now**",
    });
    expect(summarize(segments)).toEqual([
      ["text", "See "],
      ["thread-reference", "thread-1"],
      ["text", " and "],
      ["code", "code"],
    ]);
    expect(rawOf(segments)).toBe(text);
    expect(hasUserMessageMarkup(parseUserMessageMarkup("[A](f5-dev://thread/a)"))).toBe(true);
  });

  it("parses a bold-wrapped thread reference as bold text and leaves prompt links alone", () => {
    expect(summarize(parseUserMessageMarkup("**[A](f5://thread/a)**"))).toEqual([
      ["bold", "[A](f5://thread/a)"],
    ]);
    const promptLink = "[A](f5://thread/a?prompt=hi) [B](f5://thread/settings)";
    expect(hasUserMessageMarkup(parseUserMessageMarkup(promptLink))).toBe(false);
  });
});

describe("clipUserMessageSegments", () => {
  it("turns a clipped thread reference into plain text", () => {
    const segments = parseUserMessageMarkup("x [Title](f5://thread/abc)");
    expect(clipUserMessageSegments(segments, 10)).toEqual([
      { kind: "text", start: 0, end: 2, raw: "x " },
      { kind: "text", start: 2, end: 10, raw: "[Title](" },
    ]);
  });

  it("clips to the 600-character collapsed prefix", () => {
    const text = `Intro \`code\` ${"word ".repeat(150)}\`tail code\` end`;
    const collapsed = buildCollapsedUserMessageText(text);
    expect(collapsed.length).toBe(600);
    const clipped = clipUserMessageSegments(parseUserMessageMarkup(text), collapsed.length);
    expect(rawOf(clipped)).toBe(collapsed);
    expect(clipped[1]).toMatchObject({ kind: "code", value: "code" });
  });

  it("clips to the 8-line collapsed prefix and keeps a clipped block as a block", () => {
    const text = "Look:\n```ts\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n```\nafter";
    const collapsed = buildCollapsedUserMessageText(text);
    const clipped = clipUserMessageSegments(parseUserMessageMarkup(text), collapsed.length);
    expect(rawOf(clipped)).toBe(collapsed);
    expect(clipped.at(-1)).toMatchObject({
      kind: "codeblock",
      value: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
    });
  });

  it("turns a clipped inline token into plain text of its raw prefix", () => {
    const segments = parseUserMessageMarkup("say **bold words** now");
    expect(clipUserMessageSegments(segments, 9)).toEqual([
      { kind: "text", start: 0, end: 4, raw: "say " },
      { kind: "text", start: 4, end: 9, raw: "**bol" },
    ]);
  });
});
