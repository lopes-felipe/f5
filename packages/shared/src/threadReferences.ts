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

/** Every thread reference in `text`, in order and without overlaps. */
export function threadReferenceMatches(text: string): ThreadReferenceMatch[] {
  if (!text.includes("://thread/")) return [];
  const matches: ThreadReferenceMatch[] = [];
  for (const match of text.matchAll(threadReferencePattern())) {
    const label = match[1];
    const threadId = match[3];
    if (!label || !threadId || isReservedThreadRoute(threadId)) continue;
    const start = match.index;
    matches.push({ start, end: start + match[0].length, raw: match[0], label, threadId });
  }
  return matches;
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
