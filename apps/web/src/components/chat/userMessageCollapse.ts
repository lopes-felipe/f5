export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 600;
import { assistantResponseContextMatches } from "@t3tools/shared/assistantResponseContext";
import {
  responseCardSeparatorLength,
  trimResponseCardSeparators,
} from "../../lib/userMessageMarkup";
export const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8;

export function shouldCollapseUserMessage(text: string): boolean {
  // Cards have their own two-line clamp; encoded payloads do not consume the comment's budget.
  // Each card renders as a block in place of the blank-line separators beside it.
  const cards = assistantResponseContextMatches(text);
  if (cards.length > 0) {
    const parts: string[] = [];
    let cursor = 0;
    cards.forEach((card, index) => {
      parts.push(trimResponseCardSeparators(text.slice(cursor, card.start), index > 0, true));
      cursor = card.end;
    });
    parts.push(trimResponseCardSeparators(text.slice(cursor), true, false));
    text = parts.filter(Boolean).join("\n");
  }
  if (text.length > USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lines = text.split("\n", USER_MESSAGE_COLLAPSE_LINE_THRESHOLD + 1);
  return lines.length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
}

export function buildCollapsedUserMessageText(text: string): string {
  const cards = assistantResponseContextMatches(text);
  if (cards.length > 0) {
    // The separators beside a card are not displayed, so they spend no budget.
    const separators = new Set<number>();
    let previousEnd = 0;
    for (const card of cards) {
      const before = responseCardSeparatorLength(text.slice(previousEnd, card.start), false);
      const after = responseCardSeparatorLength(text.slice(card.end), true);
      for (let index = card.start - before; index < card.start; index++) separators.add(index);
      for (let index = card.end; index < card.end + after; index++) separators.add(index);
      previousEnd = card.end;
    }
    let consumed = 0;
    let lines = 1;
    let cardIndex = 0;
    let index = 0;
    for (; index < text.length; index++) {
      const card = cards[cardIndex];
      if (card && index === card.start) {
        // A card after displayed text starts a new line.
        if (consumed > 0) lines++;
        index = card.end - 1;
        cardIndex++;
        continue;
      }
      if (lines > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD) {
        // Like the plain path, drop the break that ended the last kept line.
        if (text[index - 1] === "\n" && !separators.has(index - 1)) index--;
        break;
      }
      if (consumed >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) break;
      if (separators.has(index)) continue;
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
