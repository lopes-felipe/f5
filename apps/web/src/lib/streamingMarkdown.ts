import { recordBrowserWork } from "./performanceCounters";
import { suffixSince, type TextRevision } from "./streamingTextRevision";
export type StreamingMarkdownBlockKind =
  | "paragraph"
  | "heading"
  | "horizontal-rule"
  | "list"
  | "blockquote"
  | "table"
  | "fenced-code";

export interface StreamingMarkdownState {
  readonly text: string;
  readonly textRevision?: TextRevision | undefined;
  readonly parsedCharacters?: number;
  readonly validatedCharacters?: number;
  readonly sealedBlocks: readonly string[];
  readonly activeBlock: string;
  readonly activeBlockKind: StreamingMarkdownBlockKind | null;
  readonly needsFullRebuild: boolean;
}

interface LineInfo {
  readonly raw: string;
  readonly content: string;
  readonly hasTerminator: boolean;
}

interface ParsedBlock {
  readonly kind: StreamingMarkdownBlockKind;
  readonly endLineExclusive: number;
  readonly sealed: boolean;
}

interface ParsedFragment {
  readonly sealedBlocks: readonly string[];
  readonly activeBlock: string;
  readonly activeBlockKind: StreamingMarkdownBlockKind | null;
}

const EMPTY_BLOCKS: readonly string[] = [];

export const EMPTY_STREAMING_MARKDOWN_STATE: StreamingMarkdownState = {
  text: "",
  sealedBlocks: EMPTY_BLOCKS,
  activeBlock: "",
  activeBlockKind: null,
  needsFullRebuild: false,
};

function splitLines(text: string): LineInfo[] {
  if (text.length === 0) {
    return [];
  }

  const lines: LineInfo[] = [];
  let start = 0;

  while (start < text.length) {
    const newlineIndex = text.indexOf("\n", start);
    if (newlineIndex === -1) {
      const raw = text.slice(start);
      lines.push({
        raw,
        content: raw.endsWith("\r") ? raw.slice(0, -1) : raw,
        hasTerminator: false,
      });
      break;
    }

    const raw = text.slice(start, newlineIndex + 1);
    const contentWithoutNewline = raw.slice(0, -1);
    lines.push({
      raw,
      content: contentWithoutNewline.endsWith("\r")
        ? contentWithoutNewline.slice(0, -1)
        : contentWithoutNewline,
      hasTerminator: true,
    });
    start = newlineIndex + 1;
  }

  return lines;
}

function joinLines(lines: readonly LineInfo[], start: number, endExclusive: number): string {
  return lines
    .slice(start, endExclusive)
    .map((line) => line.raw)
    .join("");
}

function isBlankLine(content: string): boolean {
  return content.trim().length === 0;
}

function isHeadingLine(content: string): boolean {
  return /^ {0,3}#{1,6}(?:\s|$)/.test(content);
}

function isHorizontalRuleLine(content: string): boolean {
  return /^ {0,3}(?:([-*_])(?:\s*\1){2,})\s*$/.test(content);
}

export function matchFence(
  content: string,
): { readonly marker: "`" | "~"; readonly length: number } | null {
  const match = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  const token = match[1];
  if (!token) {
    return null;
  }

  const marker = token[0];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  return {
    marker,
    length: token.length,
  };
}

export function isFenceClosingLine(
  content: string,
  fence: { readonly marker: "`" | "~"; readonly length: number },
): boolean {
  const trimmedStart = content.replace(/^ {0,3}/, "");
  let index = 0;
  while (index < trimmedStart.length && trimmedStart[index] === fence.marker) {
    index += 1;
  }

  return index >= fence.length && trimmedStart.slice(index).trim().length === 0;
}

function isListLine(content: string): boolean {
  return /^ {0,3}(?:[*+-]|\d+[.)])\s+/.test(content);
}

function isIndentedContinuationLine(content: string): boolean {
  return /^(?: {2,}|\t)\S/.test(content);
}

function isBlockquoteLine(content: string): boolean {
  return /^ {0,3}>\s?/.test(content);
}

function isTableDelimiterLine(content: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?\|?\s*$/.test(content);
}

function looksLikeTableRow(content: string): boolean {
  if (content.trim().length === 0) {
    return false;
  }
  return content.includes("|");
}

function isTableStart(lines: readonly LineInfo[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];
  if (!current || !next) {
    return false;
  }
  return looksLikeTableRow(current.content) && isTableDelimiterLine(next.content);
}

function isBlockStarter(lines: readonly LineInfo[], index: number): boolean {
  const current = lines[index];
  if (!current) {
    return false;
  }

  return (
    isHeadingLine(current.content) ||
    isHorizontalRuleLine(current.content) ||
    matchFence(current.content) !== null ||
    isListLine(current.content) ||
    isBlockquoteLine(current.content) ||
    isTableStart(lines, index)
  );
}

function consumeHeadingOrRule(
  lines: readonly LineInfo[],
  index: number,
  kind: "heading" | "horizontal-rule",
): ParsedBlock {
  const line = lines[index];
  return {
    kind,
    endLineExclusive: index + 1,
    sealed: Boolean(line?.hasTerminator) || index + 1 < lines.length,
  };
}

function consumeFencedCodeBlock(lines: readonly LineInfo[], index: number): ParsedBlock {
  const openingFence = matchFence(lines[index]?.content ?? "");
  if (!openingFence) {
    return {
      kind: "fenced-code",
      endLineExclusive: index + 1,
      sealed: false,
    };
  }

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line || !isFenceClosingLine(line.content, openingFence)) {
      continue;
    }

    return {
      kind: "fenced-code",
      endLineExclusive: cursor + 1,
      sealed: line.hasTerminator || cursor + 1 < lines.length,
    };
  }

  return {
    kind: "fenced-code",
    endLineExclusive: lines.length,
    sealed: false,
  };
}

function consumeListBlock(lines: readonly LineInfo[], index: number): ParsedBlock {
  let cursor = index + 1;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line) {
      break;
    }

    if (isBlankLine(line.content)) {
      let afterBlank = cursor + 1;
      while (afterBlank < lines.length && isBlankLine(lines[afterBlank]?.content ?? "")) {
        afterBlank += 1;
      }

      if (afterBlank >= lines.length) {
        return {
          kind: "list",
          endLineExclusive: cursor,
          sealed: true,
        };
      }

      if (
        isListLine(lines[afterBlank]?.content ?? "") ||
        isIndentedContinuationLine(lines[afterBlank]?.content ?? "")
      ) {
        cursor = afterBlank + 1;
        continue;
      }

      return {
        kind: "list",
        endLineExclusive: cursor,
        sealed: true,
      };
    }

    if (isListLine(line.content) || isIndentedContinuationLine(line.content)) {
      cursor += 1;
      continue;
    }

    return {
      kind: "list",
      endLineExclusive: cursor,
      sealed: true,
    };
  }

  return {
    kind: "list",
    endLineExclusive: lines.length,
    sealed: false,
  };
}

function consumeBlockquoteBlock(lines: readonly LineInfo[], index: number): ParsedBlock {
  let cursor = index + 1;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line) {
      break;
    }

    if (isBlankLine(line.content)) {
      let afterBlank = cursor + 1;
      while (afterBlank < lines.length && isBlankLine(lines[afterBlank]?.content ?? "")) {
        afterBlank += 1;
      }

      if (afterBlank >= lines.length) {
        return {
          kind: "blockquote",
          endLineExclusive: cursor,
          sealed: true,
        };
      }

      if (isBlockquoteLine(lines[afterBlank]?.content ?? "")) {
        cursor = afterBlank + 1;
        continue;
      }

      return {
        kind: "blockquote",
        endLineExclusive: cursor,
        sealed: true,
      };
    }

    if (isBlockquoteLine(line.content)) {
      cursor += 1;
      continue;
    }

    return {
      kind: "blockquote",
      endLineExclusive: cursor,
      sealed: true,
    };
  }

  return {
    kind: "blockquote",
    endLineExclusive: lines.length,
    sealed: false,
  };
}

function consumeTableBlock(lines: readonly LineInfo[], index: number): ParsedBlock {
  let cursor = index + 2;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line || isBlankLine(line.content) || !looksLikeTableRow(line.content)) {
      return {
        kind: "table",
        endLineExclusive: cursor,
        sealed: true,
      };
    }

    cursor += 1;
  }

  return {
    kind: "table",
    endLineExclusive: lines.length,
    sealed: false,
  };
}

function consumeParagraph(lines: readonly LineInfo[], index: number): ParsedBlock {
  let cursor = index + 1;

  while (cursor < lines.length) {
    const next = lines[cursor];
    if (!next) {
      break;
    }

    if (isBlankLine(next.content) || isBlockStarter(lines, cursor)) {
      return {
        kind: "paragraph",
        endLineExclusive: cursor,
        sealed: true,
      };
    }

    cursor += 1;
  }

  return {
    kind: "paragraph",
    endLineExclusive: lines.length,
    sealed: false,
  };
}

function consumeBlock(lines: readonly LineInfo[], index: number): ParsedBlock {
  const content = lines[index]?.content ?? "";

  if (isHeadingLine(content)) {
    return consumeHeadingOrRule(lines, index, "heading");
  }

  if (isHorizontalRuleLine(content)) {
    return consumeHeadingOrRule(lines, index, "horizontal-rule");
  }

  if (matchFence(content)) {
    return consumeFencedCodeBlock(lines, index);
  }

  if (isListLine(content)) {
    return consumeListBlock(lines, index);
  }

  if (isBlockquoteLine(content)) {
    return consumeBlockquoteBlock(lines, index);
  }

  if (isTableStart(lines, index)) {
    return consumeTableBlock(lines, index);
  }

  return consumeParagraph(lines, index);
}

function parseStreamingMarkdown(text: string): ParsedFragment {
  if (text.length === 0) {
    return {
      sealedBlocks: EMPTY_BLOCKS,
      activeBlock: "",
      activeBlockKind: null,
    };
  }

  const lines = splitLines(text);
  const sealedBlocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && isBlankLine(lines[index]?.content ?? "")) {
      index += 1;
    }

    if (index >= lines.length) {
      break;
    }

    const parsedBlock = consumeBlock(lines, index);
    const blockText = joinLines(lines, index, parsedBlock.endLineExclusive);

    if (!parsedBlock.sealed) {
      return {
        sealedBlocks: sealedBlocks.length > 0 ? sealedBlocks : EMPTY_BLOCKS,
        activeBlock: blockText,
        activeBlockKind: parsedBlock.kind,
      };
    }

    sealedBlocks.push(blockText);
    index = parsedBlock.endLineExclusive;
  }

  return {
    sealedBlocks: sealedBlocks.length > 0 ? sealedBlocks : EMPTY_BLOCKS,
    activeBlock: "",
    activeBlockKind: null,
  };
}

interface FenceProgress {
  readonly marker: "`" | "~";
  readonly length: number;
  leading: number;
  markers: number;
  trailing: boolean;
  invalid: boolean;
}
const stableParagraphs = new WeakSet<StreamingMarkdownState>();
const fenceProgress = new WeakMap<StreamingMarkdownState, FenceProgress>();
function scanFence(progress: FenceProgress, suffix: string): boolean {
  for (const character of suffix) {
    if (character === "\n") {
      if (!progress.invalid && progress.markers >= progress.length) return false;
      progress.leading = 0;
      progress.markers = 0;
      progress.trailing = false;
      progress.invalid = false;
    } else if (!progress.invalid) {
      if (!progress.markers && character === " " && progress.leading < 3) progress.leading++;
      else if (!progress.trailing && character === progress.marker) progress.markers++;
      else if (progress.markers >= progress.length && /\s/u.test(character))
        progress.trailing = true;
      else progress.invalid = true;
    }
  }
  return true;
}
interface BlockLineProgress {
  readonly tail: string;
  readonly compatible: boolean;
}
const blockLineProgress = new WeakMap<StreamingMarkdownState, BlockLineProgress>();
function appendCompatibleLines(
  previous: StreamingMarkdownState,
  suffix: string,
): { parsed: ParsedFragment; lines: BlockLineProgress; scannedCharacters: number } | null {
  const kind = previous.activeBlockKind;
  if (kind !== "list" && kind !== "blockquote" && kind !== "table") return null;
  const compatibleLine = (line: string) =>
    kind === "list"
      ? isListLine(line) || isIndentedContinuationLine(line)
      : kind === "blockquote"
        ? isBlockquoteLine(line)
        : looksLikeTableRow(line);
  let before = blockLineProgress.get(previous);
  let initialScan = 0;
  if (!before) {
    const lines = splitLines(previous.activeBlock);
    // An unfinished table delimiter can still turn back into ordinary prose.
    if (kind === "table" && lines.filter((line) => line.hasTerminator).length < 2) return null;
    const last = lines.at(-1);
    const tail = last?.hasTerminator ? "" : (last?.raw ?? "");
    before = { tail, compatible: tail.length > 0 && compatibleLine(tail.replace(/\r$/u, "")) };
    initialScan = previous.activeBlock.length;
  }
  let next: BlockLineProgress;
  let scannedCharacters = initialScan + suffix.length;
  if (!suffix.includes("\n")) {
    const tail = before.tail + suffix;
    if (!before.compatible && !compatibleLine(tail.replace(/\r$/u, ""))) return null;
    next = { tail, compatible: true };
  } else {
    const lines = splitLines(before.tail + suffix);
    scannedCharacters += before.tail.length;
    for (let index = 0; index < lines.length; index++) {
      if (index === 0 && before.compatible) continue;
      if (!compatibleLine(lines[index]!.content)) return null;
    }
    const last = lines.at(-1);
    next = {
      tail: last?.hasTerminator ? "" : (last?.raw ?? ""),
      compatible: Boolean(last && !last.hasTerminator),
    };
  }
  return {
    parsed: {
      sealedBlocks: EMPTY_BLOCKS,
      activeBlock: previous.activeBlock + suffix,
      activeBlockKind: kind,
    },
    lines: next,
    scannedCharacters,
  };
}

/** Revisit the full active block only when its grammar can actually change. */
function appendStableActive(
  previous: StreamingMarkdownState,
  suffix: string,
): {
  parsed: ParsedFragment;
  fence?: FenceProgress;
  paragraph?: true;
  lines?: BlockLineProgress;
  scannedCharacters?: number;
} | null {
  const compatible = appendCompatibleLines(previous, suffix);
  if (compatible) return compatible;
  if (previous.activeBlockKind === "paragraph" && !suffix.includes("\n")) {
    const tailStart = stableParagraphs.has(previous)
      ? 0
      : previous.activeBlock.lastIndexOf("\n") + 1;
    if (
      stableParagraphs.has(previous) ||
      /^ {0,3}[A-Za-z]/u.test(previous.activeBlock.slice(tailStart, tailStart + 4))
    )
      return {
        paragraph: true,
        parsed: {
          sealedBlocks: EMPTY_BLOCKS,
          activeBlock: previous.activeBlock + suffix,
          activeBlockKind: "paragraph",
        },
      };
  }
  if (previous.activeBlockKind !== "fenced-code") return null;
  let before = fenceProgress.get(previous);
  if (!before) {
    const openingEnd = previous.activeBlock.indexOf("\n");
    if (openingEnd < 0) return null; // The opening fence can still grow/change.
    const opening = matchFence(previous.activeBlock.slice(0, openingEnd));
    if (!opening) return null;
    before = { ...opening, leading: 0, markers: 0, trailing: false, invalid: false };
    const lastLine = previous.activeBlock.slice(previous.activeBlock.lastIndexOf("\n") + 1);
    if (!scanFence(before, lastLine)) return null;
  }
  const next = { ...before };
  if (!scanFence(next, suffix)) return null;
  return {
    parsed: {
      sealedBlocks: EMPTY_BLOCKS,
      activeBlock: previous.activeBlock + suffix,
      activeBlockKind: "fenced-code",
    },
    fence: next,
  };
}

export function advanceStreamingMarkdown(
  previous: StreamingMarkdownState | null,
  nextText: string,
  textRevision?: TextRevision,
): StreamingMarkdownState {
  if (previous && previous.text === nextText) {
    return previous.textRevision === textRevision ? previous : { ...previous, textRevision };
  }

  if (!previous) {
    if (nextText.length === 0) {
      return EMPTY_STREAMING_MARKDOWN_STATE;
    }

    recordBrowserWork("markdownParsedCharacters", nextText.length);
    const parsed = parseStreamingMarkdown(nextText);
    return {
      text: nextText,
      textRevision,
      parsedCharacters: nextText.length,
      validatedCharacters: 0,
      sealedBlocks: parsed.sealedBlocks,
      activeBlock: parsed.activeBlock,
      activeBlockKind: parsed.activeBlockKind,
      needsFullRebuild: false,
    };
  }

  const knownSuffix = suffixSince(previous.textRevision, textRevision);
  // Revisions come only from reducer appends. Missing/expired provenance keeps
  // the validated full-text path used for snapshots, replacements and rewinds.
  if (
    knownSuffix === null &&
    (previous.textRevision !== undefined ||
      textRevision !== undefined ||
      !nextText.startsWith(previous.text))
  ) {
    recordBrowserWork("markdownParsedCharacters", nextText.length);
    const parsed = parseStreamingMarkdown(nextText);
    return {
      text: nextText,
      textRevision,
      parsedCharacters: nextText.length + (previous?.parsedCharacters ?? 0),
      validatedCharacters: previous?.validatedCharacters ?? 0,
      sealedBlocks: parsed.sealedBlocks,
      activeBlock: parsed.activeBlock,
      activeBlockKind: parsed.activeBlockKind,
      needsFullRebuild: true,
    };
  }

  const suffix = knownSuffix ?? nextText.slice(previous.text.length);
  if (suffix.length === 0) {
    return previous;
  }

  const incremental = appendStableActive(previous, suffix);
  const parsed = incremental?.parsed ?? parseStreamingMarkdown(`${previous.activeBlock}${suffix}`);
  const sealedBlocks =
    parsed.sealedBlocks.length === 0
      ? previous.sealedBlocks
      : [...previous.sealedBlocks, ...parsed.sealedBlocks];

  recordBrowserWork(
    "markdownParsedCharacters",
    incremental
      ? (incremental.scannedCharacters ?? suffix.length)
      : previous.activeBlock.length + suffix.length,
  );
  recordBrowserWork("markdownValidatedCharacters", knownSuffix === null ? previous.text.length : 0);
  const result: StreamingMarkdownState = {
    text: nextText,
    textRevision,
    parsedCharacters:
      (previous.parsedCharacters ?? 0) +
      (incremental
        ? (incremental.scannedCharacters ?? suffix.length)
        : previous.activeBlock.length + suffix.length),
    validatedCharacters:
      (previous.validatedCharacters ?? 0) + (knownSuffix === null ? previous.text.length : 0),
    sealedBlocks,
    activeBlock: parsed.activeBlock,
    activeBlockKind: parsed.activeBlockKind,
    needsFullRebuild: false,
  };
  if (incremental?.lines) blockLineProgress.set(result, incremental.lines);
  if (incremental?.fence) fenceProgress.set(result, incremental.fence);
  if (incremental?.paragraph) stableParagraphs.add(result);
  return result;
}
