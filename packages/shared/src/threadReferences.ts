/**
 * Thread references point a message at another F5 thread as context: `[Title](f5://thread/<id>)`.
 * They reuse the prompt-link grammar, so a reference opens the thread when clicked, but only a
 * bare thread link counts. A link with a query (`f5://thread/<id>?prompt=…`) is a prompt link.
 */
import {
  APP_LINK_SCHEME_SOURCE,
  isReservedThreadRoute,
  PROMPT_LINK_SCHEME,
  THREAD_LINK_ID_SOURCE,
} from "./promptLinks";

/** The most distinct threads one message may reference. */
export const THREAD_REFERENCE_MAX_PER_MESSAGE = 10;
/** Hard ceiling for the referenced-thread block the server appends to a provider input. */
export const THREAD_REFERENCE_CONTEXT_MAX_CHARS = 6_000;
/** Longest label `sanitizeThreadReferenceLabel` produces, in UTF-16 code units. */
export const THREAD_REFERENCE_LABEL_MAX_LENGTH = 120;

const THREAD_REFERENCE_SOURCE = `\\[([^\\[\\]\\n]{1,200})\\]\\((${APP_LINK_SCHEME_SOURCE}):\\/\\/thread\\/(${THREAD_LINK_ID_SOURCE})\\)`;

/** A new global regex matching thread references. Callers own its `lastIndex`. */
export function threadReferencePattern(flags = "g"): RegExp {
  return new RegExp(THREAD_REFERENCE_SOURCE, flags);
}

const BARE_THREAD_LINK = new RegExp(
  `^(${APP_LINK_SCHEME_SOURCE}):\\/\\/thread\\/(${THREAD_LINK_ID_SOURCE})$`,
);

/** The thread id a bare thread link (`f5://thread/<id>`, no query) names, or null. */
export function threadIdOfThreadReferenceUrl(url: string): string | null {
  const match = BARE_THREAD_LINK.exec(url);
  const threadId = match?.[2];
  return threadId && !isReservedThreadRoute(threadId) ? threadId : null;
}

const THREAD_ID = new RegExp(`^${THREAD_LINK_ID_SOURCE}$`);

/** True when `threadId` can be carried by a thread reference. */
export function isThreadReferenceId(threadId: string): boolean {
  return THREAD_ID.test(threadId) && !isReservedThreadRoute(threadId);
}

// Brackets and backslashes would end or escape the link label; line breaks, control characters
// and the object replacement character (Lexical's inline placeholder) would break the chip.
// eslint-disable-next-line no-control-regex
const LABEL_UNSAFE = /[[\]\\\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffc]/g;

export function sanitizeThreadReferenceLabel(title: string): string {
  const collapsed = title.replace(LABEL_UNSAFE, " ").replace(/\s+/g, " ").trim();
  let label = collapsed;
  if (label.length > THREAD_REFERENCE_LABEL_MAX_LENGTH) {
    let end = THREAD_REFERENCE_LABEL_MAX_LENGTH;
    const last = label.charCodeAt(end - 1);
    // Keep a surrogate pair whole rather than leave half of it at the end.
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    label = label.slice(0, end).trimEnd();
  }
  return label.length > 0 ? label : "Thread";
}

export function formatThreadReference(input: {
  readonly threadId: string;
  readonly title: string;
  readonly scheme?: string;
}): string {
  const scheme = input.scheme ?? PROMPT_LINK_SCHEME;
  return `[${sanitizeThreadReferenceLabel(input.title)}](${scheme}://thread/${input.threadId})`;
}

export interface ThreadReferenceMatch {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly label: string;
  readonly threadId: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Line ranges of closed fenced code blocks, as `[start, end)` offsets into `text`. */
function fencedBlockRanges(text: string): Array<readonly [number, number]> {
  const lines: Array<{ readonly start: number; readonly end: number; readonly next: number }> = [];
  for (let start = 0; start <= text.length; ) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, next: newline === -1 ? text.length : newline + 1 });
    if (newline === -1) break;
    start = newline + 1;
  }
  const ranges: Array<readonly [number, number]> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const open = FENCE_OPEN.exec(text.slice(line.start, line.end));
    const token = open?.[1];
    // A backtick fence's info string may not contain backticks (```a``` is a code span).
    if (!token || (token[0] === "`" && open[2]?.includes("`"))) continue;
    const closer = new RegExp(`^ {0,3}\\${token[0]}{${token.length},}\\s*$`);
    for (let close = index + 1; close < lines.length; close++) {
      const candidate = lines[close]!;
      if (!closer.test(text.slice(candidate.start, candidate.end))) continue;
      ranges.push([line.start, candidate.next]);
      index = close;
      break;
    }
  }
  return ranges;
}

/**
 * Every thread reference in `text`, in order and without overlaps. A reference inside a code
 * span or fenced block is literal text, the same as the message bubble shows it, so pasted docs
 * and logs never reference a thread.
 */
export function threadReferenceMatches(text: string): ThreadReferenceMatch[] {
  if (!text.includes("://thread/")) return [];
  const matches: ThreadReferenceMatch[] = [];
  const reference = threadReferencePattern("y");
  const fences = text.includes("```") || text.includes("~~~") ? fencedBlockRanges(text) : [];
  // A run length that found no closer has none later in that paragraph either (the later run
  // would have closed it), so each length is scanned at most once per paragraph.
  const unclosable = new Map<number, number>();
  let paragraphEnd = -1;
  let fence = 0;
  let index = 0;
  while (index < text.length) {
    const block = fences[fence];
    if (block && index >= block[0]) {
      index = Math.max(index, block[1]);
      fence++;
      continue;
    }
    const limit = block ? block[0] : text.length;
    const char = text[index];
    if (char === "\\" && PUNCTUATION.test(text[index + 1] ?? "")) {
      index += 2;
      continue;
    }
    if (char === "[") {
      reference.lastIndex = index;
      const match = reference.exec(text);
      const label = match?.[1];
      const threadId = match?.[3];
      if (match && label && threadId && !isReservedThreadRoute(threadId)) {
        const end = index + match[0].length;
        matches.push({ start: index, end, raw: match[0], label, threadId });
        index = end;
        continue;
      }
    }
    if (char === "`") {
      let run = 1;
      while (text[index + run] === "`") run++;
      // A code span closes with a run of exactly the same length within the paragraph.
      if (paragraphEnd < index) {
        const next = text.indexOf("\n\n", index);
        paragraphEnd = next === -1 ? text.length : next;
      }
      const end = Math.min(limit, paragraphEnd);
      if (unclosable.get(run) === end) {
        index += run;
        continue;
      }
      let close = text.indexOf("`", index + run);
      while (close !== -1 && close < end) {
        let closeRun = 1;
        while (text[close + closeRun] === "`") closeRun++;
        if (closeRun === run) break;
        close = text.indexOf("`", close + closeRun);
      }
      if (close !== -1 && close < end) {
        index = close + run;
      } else {
        unclosable.set(run, end);
        index += run;
      }
      continue;
    }
    index++;
  }
  return matches;
}

// `/command` or `$skill` at the start. A pasted absolute path (`/Users/me/…`) is not a command.
const COMMAND_INPUT = /^\s*(?:\/[A-Za-z][\w:-]*(?:\s|$)|\$[A-Za-z])/;

/**
 * True when `text` is a slash command or skill invocation. Providers parse those themselves, so
 * F5 neither appends referenced-thread context to them nor lets their references grant access.
 */
export function isThreadReferenceCommandInput(text: string): boolean {
  return COMMAND_INPUT.test(text);
}

/**
 * The threads a message effectively references: what grants are written for and what the
 * referenced-thread block lists. Commands reference nothing.
 */
export function effectiveThreadReferenceIds(
  text: string,
  options: { readonly exclude?: string } = {},
): string[] {
  return isThreadReferenceCommandInput(text) ? [] : referencedThreadIds([text], options);
}

/** True when `text` references more distinct threads than one message may. */
export function exceedsThreadReferenceLimit(text: string): boolean {
  return (
    new Set(threadReferenceMatches(text).map((match) => match.threadId)).size >
    THREAD_REFERENCE_MAX_PER_MESSAGE
  );
}

/** The distinct thread ids `texts` reference, in order of first appearance and capped. */
export function referencedThreadIds(
  texts: ReadonlyArray<string>,
  options: { readonly exclude?: string } = {},
): string[] {
  const ids: string[] = [];
  for (const text of texts) {
    for (const match of threadReferenceMatches(text)) {
      if (match.threadId === options.exclude || ids.includes(match.threadId)) continue;
      ids.push(match.threadId);
      if (ids.length >= THREAD_REFERENCE_MAX_PER_MESSAGE) return ids;
    }
  }
  return ids;
}

/** `text` with each thread reference replaced by its label. */
export function threadReferencesToLabels(text: string): string {
  const matches = threadReferenceMatches(text);
  if (matches.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + match.label;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}
