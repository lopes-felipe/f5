/**
 * Message-mode question answers reach the provider as a follow-up user turn whose text is
 * the answers record as JSON (`{ [questionId]: { answers: string[] } }`). These helpers turn
 * that text back into the chosen answers for display; the delivered text is never changed.
 */

/** Prefix of the user message that carries a message-mode answer. */
export const ANSWER_DELIVERY_MESSAGE_ID_PREFIX = "answer:";

/** The answers in delivery order, or null when the text is not an answers record. */
export function parseAnswerDeliveryText(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const answers: string[] = [];
  for (const entry of Object.values(parsed)) {
    const values = (entry as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
      return null;
    }
    answers.push(...values);
  }
  return answers.length > 0 ? answers : null;
}

/** Readable text for an answer-delivery message; null for any other message. */
export function answerDeliveryDisplayText(message: { id: string; text: string }): string | null {
  if (!message.id.startsWith(ANSWER_DELIVERY_MESSAGE_ID_PREFIX)) return null;
  return parseAnswerDeliveryText(message.text)?.join(" · ") ?? null;
}
