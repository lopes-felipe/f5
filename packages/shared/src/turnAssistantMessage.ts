/** ECMAScript WhiteSpace and LineTerminator characters, also used by SQLite trim. */
export const ASSISTANT_TEXT_WHITESPACE =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Cuts `text` to `maxChars` code points, ending with an ellipsis when shortened. */
export function truncateMessagePreview(text: string, maxChars: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxChars) return chars.join("");
  return `${chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Whether a turn is still producing output. A thread preview's "last reply" skips such a
 * turn and shows the newest settled reply before it; interrupted and failed turns count.
 */
export function isTurnInProgress(state: string | null | undefined): boolean {
  return state === "pending" || state === "running";
}

/** Messages must be in creation order and already scoped to one thread. */
export function resolveTurnAssistantMessage<
  M extends {
    readonly turnId?: string | null;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  },
>(messages: ReadonlyArray<M>, turnId: string): M | undefined {
  return messages.findLast(
    (message) =>
      message.turnId === turnId &&
      message.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
}
