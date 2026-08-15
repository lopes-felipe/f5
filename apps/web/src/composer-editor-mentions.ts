import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      raw: string;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

type MentionTokenMatch = {
  path: string;
  raw: string;
  start: number;
  end: number;
};

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function unescapeQuotedMentionPath(path: string): string {
  return path.replace(/\\(.)/g, "$1");
}

function collectMentionTokenMatches(text: string): MentionTokenMatch[] {
  const matches: MentionTokenMatch[] = [];

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const unquotedPath = match[3];
    const path =
      quotedPath !== undefined ? unescapeQuotedMentionPath(quotedPath) : (unquotedPath ?? "");
    const matchIndex = match.index ?? 0;
    const start = matchIndex + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    const raw = text.slice(start, end);
    if (path.length > 0) {
      matches.push({ path, raw, start, end });
    }
  }

  return matches;
}

/**
 * Composer surround-selection pairs. Keys are the opening character that a
 * user types while a non-collapsed range is active; the value is the pair
 * `[open, close]` that should bracket the selection. For symmetric markers
 * (quotes, backticks, `*`, `_`) open and close are the same character.
 */
export const COMPOSER_SURROUND_PAIRS: Readonly<Record<string, readonly [string, string]>> = {
  "(": ["(", ")"],
  "[": ["[", "]"],
  "{": ["{", "}"],
  "<": ["<", ">"],
  "«": ["«", "»"],
  "`": ["`", "`"],
  '"': ['"', '"'],
  "'": ["'", "'"],
  "*": ["*", "*"],
  _: ["_", "_"],
};

/**
 * Returns `true` if the prompt range `[start, end)` overlaps or abuts any
 * inline-token position (mention or terminal-context placeholder). Offsets
 * are expressed in the prompt's text-content space (the same space returned
 * by `$getRoot().getTextContent()`), where mentions occupy their serialized
 * literal token length and terminal-context nodes occupy a single placeholder
 * character.
 *
 * The composer's inline-token cursor math (getAbsoluteOffsetForPoint,
 * ComposerInlineTokenBackspacePlugin, etc.) assumes tokens are never split,
 * so callers should fall back to default insert behavior whenever this
 * function returns true — never try to wrap across a token boundary.
 */
export function doesSelectionTouchInlineToken(
  prompt: string,
  selectionStart: number,
  selectionEnd: number,
): boolean {
  if (!prompt) return false;
  const [start, end] =
    selectionStart <= selectionEnd
      ? [selectionStart, selectionEnd]
      : [selectionEnd, selectionStart];
  if (start === end) return false;

  for (const match of collectMentionTokenMatches(prompt)) {
    if (rangesTouch(start, end, match.start, match.end)) return true;
  }

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) continue;
    if (rangesTouch(start, end, index, index + 1)) return true;
  }

  return false;
}

function rangesTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // Overlap: half-open ranges intersect
  if (aStart < bEnd && bStart < aEnd) return true;
  // Abut: selection's edge touches the token's edge on either side
  if (aEnd === bStart || aStart === bEnd) return true;
  return false;
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
  for (const match of collectMentionTokenMatches(text)) {
    const mentionStart = match.start;
    const mentionEnd = match.end;

    if (mentionStart > cursor) {
      pushTextSegment(segments, text.slice(cursor, mentionStart));
    }

    segments.push({ type: "mention", path: match.path, raw: match.raw });

    cursor = mentionEnd;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor, index)));
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor)));
  }

  return segments;
}

export function collectComposerMentionPaths(prompt: string): string[] {
  return splitPromptIntoComposerSegments(prompt)
    .filter(
      (segment): segment is Extract<ComposerPromptSegment, { type: "mention" }> =>
        segment.type === "mention",
    )
    .map((segment) => segment.path);
}
