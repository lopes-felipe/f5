import {
  formatAnswerDeliveryAnswers,
  isAnswerMessageId,
  parseAnswerDeliveryText,
} from "@t3tools/shared/answerDelivery";

/**
 * Readable text for a message-mode answer, which reaches the provider as JSON; null for
 * any other message. Display only: the delivered text is never changed.
 */
export function answerDeliveryDisplayText(message: { id: string; text: string }): string | null {
  if (!isAnswerMessageId(message.id)) return null;
  const answers = parseAnswerDeliveryText(message.text);
  return answers ? formatAnswerDeliveryAnswers(answers) : null;
}
