import { isReservedThreadRoute } from "@t3tools/shared/promptLinks";
import { threadReferencePattern } from "@t3tools/shared/threadReferences";

import { isFenceClosingLine, matchFence } from "./streamingMarkdown";

/**
 * The little Markdown a user bubble renders: fenced code blocks, code spans,
 * `**bold**` and thread references (`[Title](f5://thread/<id>)`). Everything else (escapes, `_`, single `*`, `~~`, headings, lists)
 * stays literal, so `__init__`, `snake_case` and `*.ts` read as typed.
 *
 * Every segment carries its source range; concatenating the `raw` of every
 * segment reproduces the source exactly.
 */
export type UserMessageSegment =
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly raw: string }
  | {
      readonly kind: "code" | "bold";
      readonly start: number;
      readonly end: number;
      readonly raw: string;
      /** The displayed content, without delimiters. */
      readonly value: string;
    }
  | {
      readonly kind: "thread-reference";
      readonly start: number;
      readonly end: number;
      readonly raw: string;
      readonly threadId: string;
      readonly label: string;
    }
  | {
      readonly kind: "codeblock";
      readonly start: number;
      readonly end: number;
      readonly raw: string;
      readonly value: string;
      /** Offsets of the content lines within `raw`, between the fence lines. */
      readonly contentOffset: number;
      readonly contentEnd: number;
      /** Opening-fence indentation removed from each content line. */
      readonly indent: number;
    };

interface SourceLine {
  readonly start: number;
  /** End of the content, before the line break. */
  readonly end: number;
  /** End including the line break. */
  readonly next: number;
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ start, end: text.length, next: text.length });
      break;
    }
    lines.push({ start, end: newline, next: newline + 1 });
    start = newline + 1;
  }
  return lines;
}

/** Content lines without the opening fence's indentation or the final line break. */
function fenceContent(body: string, indent: number): string {
  if (body.length === 0) return "";
  const lines = body.split("\n");
  const strip = new RegExp(`^ {0,${indent}}`);
  return lines
    .map((line) => line.replace(strip, ""))
    .join("\n")
    .replace(/\n$/, "");
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/;

function codeSpanContent(inner: string): string {
  const flattened = inner.replace(/\r?\n/g, " ");
  if (
    flattened.length >= 2 &&
    flattened.startsWith(" ") &&
    flattened.endsWith(" ") &&
    flattened.trim().length > 0
  ) {
    return flattened.slice(1, -1);
  }
  return flattened;
}

function backtickRunLength(text: string, index: number): number {
  let length = 0;
  while (text[index + length] === "`") length += 1;
  return length;
}

/** Index of the first element of the ascending `values` that is `>= target`. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Closer lookups for one inline run, precomputed in a single pass so an opener
 * that never closes costs a lookup, not a rescan of the rest of the message
 * (user text can be 120k characters and is parsed during render).
 */
class InlineClosers {
  /** Starts of maximal backtick runs, grouped by run length. */
  private backtickRunsByLength: Map<number, number[]> | null = null;
  /** Positions of `**` that can close bold. */
  private boldClosers: number[] | null = null;
  private paragraphBreak = -1;

  constructor(private readonly text: string) {}

  /**
   * Where the paragraph containing `from` ends: a span must close before the
   * next blank line. Queries arrive in ascending order, so this is amortized linear.
   */
  private paragraphEnd(from: number): number {
    if (this.paragraphBreak === -1 || from > this.paragraphBreak) {
      const next = this.text.indexOf("\n\n", from);
      this.paragraphBreak = next === -1 ? Infinity : next;
    }
    return this.paragraphBreak;
  }

  /** The end of the closing run of exactly `length` backticks after `from`, or -1. */
  closingBackticks(from: number, length: number): number {
    if (!this.backtickRunsByLength) {
      const runs = new Map<number, number[]>();
      let index = this.text.indexOf("`");
      while (index !== -1) {
        const run = backtickRunLength(this.text, index);
        const starts = runs.get(run);
        if (starts) starts.push(index);
        else runs.set(run, [index]);
        index = this.text.indexOf("`", index + run);
      }
      this.backtickRunsByLength = runs;
    }
    const starts = this.backtickRunsByLength.get(length);
    if (!starts) return -1;
    const start = starts[lowerBound(starts, from)];
    if (start === undefined || start >= this.paragraphEnd(from)) return -1;
    return start + length;
  }

  /** The start of the `**` closing bold opened before `from`, or -1. */
  closingBold(from: number): number {
    if (!this.boldClosers) {
      const closers: number[] = [];
      let index = this.text.indexOf("**");
      while (index !== -1) {
        const before = this.text[index - 1] ?? "";
        const after = this.text[index + 2] ?? "";
        if (!WHITESPACE.test(before) && !WORD_CHARACTER.test(after)) closers.push(index);
        index = this.text.indexOf("**", index + 1);
      }
      this.boldClosers = closers;
    }
    const close = this.boldClosers[lowerBound(this.boldClosers, from + 1)];
    if (close === undefined || close >= this.paragraphEnd(from)) return -1;
    return close;
  }
}

function parseInline(text: string, offset: number, segments: UserMessageSegment[]): void {
  const closers = new InlineClosers(text);
  const threadReference = threadReferencePattern("y");
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      segments.push({
        kind: "text",
        start: offset + textStart,
        end: offset + end,
        raw: text.slice(textStart, end),
      });
    }
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\" && PUNCTUATION.test(text[index + 1] ?? "")) {
      index += 2;
      continue;
    }
    // A reference is atomic, so backticks and `**` inside its title stay part of the chip.
    if (char === "[") {
      threadReference.lastIndex = index;
      const match = threadReference.exec(text);
      if (match?.[1] && match[3] && !isReservedThreadRoute(match[3])) {
        flushText(index);
        const end = index + match[0].length;
        segments.push({
          kind: "thread-reference",
          start: offset + index,
          end: offset + end,
          raw: match[0],
          threadId: match[3],
          label: match[1],
        });
        index = end;
        textStart = index;
        continue;
      }
    }
    if (char === "`") {
      const run = backtickRunLength(text, index);
      const close = closers.closingBackticks(index + run, run);
      if (close === -1) {
        index += run;
        continue;
      }
      flushText(index);
      const raw = text.slice(index, close);
      segments.push({
        kind: "code",
        start: offset + index,
        end: offset + close,
        raw,
        value: codeSpanContent(raw.slice(run, -run)),
      });
      index = close;
      textStart = index;
      continue;
    }
    if (
      char === "*" &&
      text[index + 1] === "*" &&
      text[index + 2] !== "*" &&
      !WORD_CHARACTER.test(text[index - 1] ?? "") &&
      !WHITESPACE.test(text[index + 2] ?? " ")
    ) {
      const close = closers.closingBold(index + 2);
      if (close !== -1) {
        flushText(index);
        const raw = text.slice(index, close + 2);
        segments.push({
          kind: "bold",
          start: offset + index,
          end: offset + close + 2,
          raw,
          value: raw.slice(2, -2),
        });
        index = close + 2;
        textStart = index;
        continue;
      }
    }
    index += 1;
  }
  flushText(text.length);
}

export function parseUserMessageMarkup(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  const lines = splitLines(text);
  // The longest closing-fence run on any line at or after each line, per
  // marker. An opener with no long-enough closer below is rejected without a
  // scan, and a successful scan ends at its closer, so parsing stays linear.
  const longestCloserFrom = {
    "`": new Int32Array(lines.length + 1),
    "~": new Int32Array(lines.length + 1),
  };
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    // Mirrors `isFenceClosingLine`.
    const closer = /^ {0,3}(`+|~+)\s*$/.exec(text.slice(line.start, line.end));
    for (const marker of ["`", "~"] as const) {
      const run = closer?.[1]?.[0] === marker ? closer[1].length : 0;
      longestCloserFrom[marker][index] = Math.max(run, longestCloserFrom[marker][index + 1]!);
    }
  }
  let runStart = 0;
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!;
    const content = text.slice(line.start, line.end);
    const fence = matchFence(content);
    // A backtick fence's info string may not contain backticks (```a``` is a code span).
    const opensFence =
      fence !== null &&
      !(fence.marker === "`" && content.trimStart().slice(fence.length).includes("`"));
    if (!opensFence) {
      lineIndex += 1;
      continue;
    }
    let closingIndex = -1;
    const hasCloser = longestCloserFrom[fence.marker][lineIndex + 1]! >= fence.length;
    for (let index = lineIndex + 1; hasCloser && index < lines.length; index += 1) {
      const candidate = lines[index]!;
      if (isFenceClosingLine(text.slice(candidate.start, candidate.end), fence)) {
        closingIndex = index;
        break;
      }
    }
    if (closingIndex === -1) {
      // An unclosed fence stays literal.
      lineIndex += 1;
      continue;
    }
    parseInline(text.slice(runStart, line.start), runStart, segments);
    const closing = lines[closingIndex]!;
    const raw = text.slice(line.start, closing.next);
    const contentOffset = line.next - line.start;
    const contentEnd = closing.start - line.start;
    const indent = content.length - content.trimStart().length;
    segments.push({
      kind: "codeblock",
      start: line.start,
      end: closing.next,
      raw,
      value: fenceContent(raw.slice(contentOffset, contentEnd), indent),
      contentOffset,
      contentEnd,
      indent,
    });
    runStart = closing.next;
    lineIndex = closingIndex + 1;
  }
  parseInline(text.slice(runStart), runStart, segments);
  return segments;
}

/**
 * The segments of a source prefix `length` characters long. A clipped code
 * block keeps its block form with clipped content; a clipped inline token
 * becomes the plain text of its raw prefix.
 */
export function clipUserMessageSegments(
  segments: readonly UserMessageSegment[],
  length: number,
): UserMessageSegment[] {
  const clipped: UserMessageSegment[] = [];
  for (const segment of segments) {
    if (segment.end <= length) {
      clipped.push(segment);
      continue;
    }
    if (segment.start >= length) break;
    const raw = segment.raw.slice(0, length - segment.start);
    if (segment.kind === "codeblock") {
      clipped.push({
        ...segment,
        end: length,
        raw,
        value: fenceContent(
          raw.slice(segment.contentOffset, Math.min(raw.length, segment.contentEnd)),
          segment.indent,
        ),
      });
    } else {
      clipped.push({ kind: "text", start: segment.start, end: length, raw });
    }
    break;
  }
  return clipped;
}

export function hasUserMessageMarkup(segments: readonly UserMessageSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "text");
}
