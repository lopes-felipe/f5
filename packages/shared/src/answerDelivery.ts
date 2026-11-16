/**
 * A message-mode question answer reaches the provider as a follow-up user turn whose
 * message id is `answer:<respond command id>`. Its Q&A card links to that id. A queued
 * answer that is edited, retried or duplicated gets a fresh message id; it keeps the
 * link by extending the original id, so the card still finds the delivered message.
 */

const ANSWER_MESSAGE_ID_PREFIX = "answer:";
const ANSWER_MESSAGE_ATTEMPT_SEPARATOR = "#";

/** The message id of the answer delivered for a `thread.user-input.respond` command. */
export function answerMessageIdFor(respondCommandId: string): string {
  return `${ANSWER_MESSAGE_ID_PREFIX}${respondCommandId}`;
}

export function isAnswerMessageId(messageId: string): boolean {
  return messageId.startsWith(ANSWER_MESSAGE_ID_PREFIX);
}

/** The id its Q&A card links to, for an answer message id from any attempt. */
export function answerMessageLinkId(messageId: string): string | null {
  if (!isAnswerMessageId(messageId)) return null;
  const separator = messageId.indexOf(ANSWER_MESSAGE_ATTEMPT_SEPARATOR);
  return separator < 0 ? messageId : messageId.slice(0, separator);
}

/**
 * A fresh message id for a queued turn being edited, retried or duplicated. An answer
 * keeps its card link; any other message gets `freshId` unchanged.
 */
export function nextQueuedMessageId(previousMessageId: string, freshId: string): string {
  const link = answerMessageLinkId(previousMessageId);
  return link ? `${link}${ANSWER_MESSAGE_ATTEMPT_SEPARATOR}${freshId}` : freshId;
}

/**
 * The answers record a delivery message carries (`{ [questionId]: { answers: string[] } }`),
 * or null when the text is anything else, such as an answer the user rewrote by hand.
 */
export function parseAnswerDeliveryRecord(
  text: string,
): Readonly<Record<string, ReadonlyArray<string>>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record: Record<string, ReadonlyArray<string>> = {};
  let count = 0;
  for (const [questionId, entry] of Object.entries(parsed)) {
    const values = (entry as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      return null;
    }
    record[questionId] = values;
    count += values.length;
  }
  return count > 0 ? record : null;
}

/** The answers in delivery order, or null when the text is not an answers record. */
export function parseAnswerDeliveryText(text: string): string[] | null {
  const record = parseAnswerDeliveryRecord(text);
  return record ? Object.values(record).flat() : null;
}

/** One line for a delivered answer, shared by the timeline and the queue. */
export function formatAnswerDeliveryAnswers(answers: ReadonlyArray<string>): string {
  return answers.join(" · ");
}
