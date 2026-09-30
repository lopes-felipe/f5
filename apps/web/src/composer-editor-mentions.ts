import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  formatInlineTerminalContextLabel,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      id: string;
      path: string;
      raw: string;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

/** Explicitly selected occurrences, in UTF-16 prompt offsets. Never inferred from text. */
export interface ComposerMention {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export const EMPTY_COMPOSER_MENTIONS: readonly ComposerMention[] = Object.freeze([]);

/** Serialize terminal chips while retaining file offsets in the sent text. */
export function materializeComposerPrompt(
  prompt: string,
  mentions: readonly ComposerMention[],
  terminalContexts: readonly TerminalContextDraft[],
): { prompt: string; mentions: ComposerMention[] } {
  let text = "";
  const nextMentions: ComposerMention[] = [];
  for (const segment of splitPromptIntoComposerSegments(prompt, terminalContexts, mentions)) {
    if (segment.type === "terminal-context") {
      if (segment.context) text += formatInlineTerminalContextLabel(segment.context);
    } else if (segment.type === "mention") {
      nextMentions.push({
        id: segment.id,
        path: segment.path,
        start: text.length,
        end: text.length + segment.raw.length,
      });
      text += segment.raw;
    } else {
      text += segment.text;
    }
  }
  const start = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    prompt: trimmed,
    mentions: normalizeComposerMentions(
      trimmed,
      nextMentions.map((mention) => ({
        ...mention,
        start: mention.start - start,
        end: mention.end - start,
      })),
    ),
  };
}

const SIMPLE_MENTION_PATH_REGEX = /^(?=.*[./])[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createComposerMention(path: string, start: number): ComposerMention {
  return {
    id: randomUUID(),
    path,
    start,
    end: start + 1 + serializeComposerMentionPath(path).length,
  };
}

/** Validate persisted metadata as well as editor snapshots; legacy text stays literal. */
export function normalizeComposerMentions(prompt: string, input: unknown): ComposerMention[] {
  if (!Array.isArray(input)) return [];
  const candidates = input
    .filter((value): value is ComposerMention => {
      if (!value || typeof value !== "object") return false;
      const { id, path, start, end } = value;
      return (
        typeof id === "string" &&
        id.length > 0 &&
        typeof path === "string" &&
        path.length > 0 &&
        !path.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER) &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end > start &&
        end <= prompt.length &&
        prompt.slice(start, end) === "@" + serializeComposerMentionPath(path)
      );
    })
    .sort((a, b) => a.start - b.start);
  const result: ComposerMention[] = [];
  const ids = new Set<string>();
  let end = 0;
  for (const mention of candidates) {
    if (mention.start < end || ids.has(mention.id)) continue;
    result.push({ id: mention.id, path: mention.path, start: mention.start, end: mention.end });
    ids.add(mention.id);
    end = mention.end;
  }
  return result;
}

export function composerMentionsEqual(
  left: readonly ComposerMention[],
  right: readonly ComposerMention[],
): boolean {
  return (
    left.length === right.length &&
    left.every((mention, index) => {
      const other = right[index];
      return (
        other?.id === mention.id &&
        other.path === mention.path &&
        other.start === mention.start &&
        other.end === mention.end
      );
    })
  );
}

/** Rebase unaffected occurrences and drop any mention touched by a text replacement. */
export function replaceComposerMentionRange(
  mentions: readonly ComposerMention[],
  start: number,
  end: number,
  replacementLength: number,
): ComposerMention[] {
  const delta = replacementLength - (end - start);
  return mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention];
    if (mention.start >= end) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    }
    return [];
  });
}

/** Plain-text controls expose the resulting value rather than editor nodes. */
export function reconcileComposerMentions(
  previous: string,
  next: string,
  mentions: readonly ComposerMention[],
  edit?: { start: number; end: number },
): ComposerMention[] {
  // Input controls can supply the original selection. This disambiguates repeated
  // text and invalidates a selected mention even if it is pasted over verbatim.
  if (edit) {
    const replacementLength = next.length - previous.length + edit.end - edit.start;
    if (
      replacementLength >= 0 &&
      previous.slice(0, edit.start) === next.slice(0, edit.start) &&
      previous.slice(edit.end) === next.slice(edit.start + replacementLength)
    ) {
      return normalizeComposerMentions(
        next,
        replaceComposerMentionRange(mentions, edit.start, edit.end, replacementLength),
      );
    }
  }
  if (previous === next) return normalizeComposerMentions(next, mentions);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return normalizeComposerMentions(
    next,
    replaceComposerMentionRange(mentions, start, oldEnd, newEnd - start),
  );
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
  mentions: readonly ComposerMention[] = EMPTY_COMPOSER_MENTIONS,
): boolean {
  if (!prompt) return false;
  const [start, end] =
    selectionStart <= selectionEnd
      ? [selectionStart, selectionEnd]
      : [selectionEnd, selectionStart];
  if (start === end) return false;

  for (const match of normalizeComposerMentions(prompt, mentions)) {
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

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
  mentions: readonly ComposerMention[] = EMPTY_COMPOSER_MENTIONS,
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;
  const validMentions = normalizeComposerMentions(prompt, mentions);
  let mentionIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    const mention = validMentions[mentionIndex];
    if (mention?.start === index) {
      pushTextSegment(segments, prompt.slice(textCursor, index));
      segments.push({
        type: "mention",
        id: mention.id,
        path: mention.path,
        raw: prompt.slice(mention.start, mention.end),
      });
      textCursor = mention.end;
      index = mention.end - 1;
      mentionIndex++;
      continue;
    }
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      pushTextSegment(segments, prompt.slice(textCursor, index));
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    pushTextSegment(segments, prompt.slice(textCursor));
  }

  return segments;
}

export function collectComposerMentionPaths(
  prompt: string,
  mentions: readonly ComposerMention[] = EMPTY_COMPOSER_MENTIONS,
): string[] {
  return normalizeComposerMentions(prompt, mentions).map((mention) => mention.path);
}

/** Remove terminal placeholders without losing mentions between removed contexts. */
export function filterComposerTerminalPlaceholders(
  prompt: string,
  mentions: readonly ComposerMention[],
  keepContextByIndex: readonly boolean[],
): { prompt: string; mentions: ComposerMention[] } {
  let text = "";
  let contextIndex = 0;
  const nextMentions: ComposerMention[] = [];
  for (const segment of splitPromptIntoComposerSegments(prompt, [], mentions)) {
    if (segment.type === "terminal-context") {
      if (keepContextByIndex[contextIndex++]) text += INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    } else if (segment.type === "mention") {
      nextMentions.push({
        id: segment.id,
        path: segment.path,
        start: text.length,
        end: text.length + segment.raw.length,
      });
      text += segment.raw;
    } else {
      text += segment.text;
    }
  }
  return { prompt: text, mentions: nextMentions };
}
