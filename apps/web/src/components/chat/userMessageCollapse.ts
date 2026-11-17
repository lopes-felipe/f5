export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 600;
import { assistantResponseContextMatches } from "@t3tools/shared/assistantResponseContext";
export const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8;

export function shouldCollapseUserMessage(text: string): boolean {
  // Cards have their own two-line clamp; encoded payloads do not consume the comment's budget.
  for (const match of assistantResponseContextMatches(text).reverse())
    text = text.slice(0, match.start) + text.slice(match.end);
  if (text.length > USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lines = text.split("\n", USER_MESSAGE_COLLAPSE_LINE_THRESHOLD + 1);
  return lines.length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
}

export function buildCollapsedUserMessageText(text: string): string {
  const cards = assistantResponseContextMatches(text);
  if (cards.length > 0) {
    let consumed = 0;
    let lines = 1;
    let cardIndex = 0;
    let index = 0;
    for (; index < text.length; index++) {
      const card = cards[cardIndex];
      if (card && index === card.start) {
        index = card.end - 1;
        cardIndex++;
        continue;
      }
      if (
        consumed >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD ||
        lines > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD
      )
        break;
      consumed++;
      if (text[index] === "\n") lines++;
    }
    return text.slice(0, index);
  }
  let candidate =
    text.length > USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD
      ? text.slice(0, USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD)
      : text;
  const lines = candidate.split("\n");
  if (lines.length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD) {
    candidate = lines.slice(0, USER_MESSAGE_COLLAPSE_LINE_THRESHOLD).join("\n");
  }
  return candidate;
}
