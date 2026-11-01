/**
 * The conversation a provider switch hands to the next agent. The server's
 * handoff trigger and the composer's pending-handoff notice share this
 * predicate so they always agree on whether there is anything to hand off.
 */

export const CONTEXT_HANDOFF_OPEN_TAG = "<f5-context-handoff v1>";
export const CONTEXT_HANDOFF_CLOSE_TAG = "</f5-context-handoff>";

export interface HandoffableMessageLike {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
}

const HANDOFF_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(CONTEXT_HANDOFF_OPEN_TAG)}[\\s\\S]*?${escapeRegExp(CONTEXT_HANDOFF_CLOSE_TAG)}`,
  "g",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes earlier rendered handoff blocks so history is never handed off twice. */
export function stripContextHandoffBlocks(text: string): string {
  return text.includes(CONTEXT_HANDOFF_OPEN_TAG) ? text.replace(HANDOFF_BLOCK_PATTERN, "") : text;
}

const compareMessages = (left: HandoffableMessageLike, right: HandoffableMessageLike) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

/**
 * Settled user and assistant messages with visible text, ordered by
 * `(createdAt, id)`. Given the triggering submission, only messages before it
 * count: it is never part of its own handoff, and submissions committed after it
 * have not happened yet from the receiving agent's point of view.
 */
export function handoffableMessages<T extends HandoffableMessageLike>(
  messages: ReadonlyArray<T>,
  triggeringMessageId?: string | null,
): T[] {
  const trigger =
    triggeringMessageId != null
      ? messages.find((message) => message.id === triggeringMessageId)
      : undefined;
  return messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.id !== triggeringMessageId &&
        (trigger === undefined || compareMessages(message, trigger) < 0) &&
        stripContextHandoffBlocks(message.text).trim().length > 0,
    )
    .toSorted(compareMessages);
}

export function hasHandoffableConversation(
  messages: ReadonlyArray<HandoffableMessageLike>,
  triggeringMessageId?: string | null,
): boolean {
  return handoffableMessages(messages, triggeringMessageId).length > 0;
}
