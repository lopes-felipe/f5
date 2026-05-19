export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 600;
export const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8;

export function shouldCollapseUserMessage(text: string): boolean {
  if (text.length > USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lines = text.split("\n", USER_MESSAGE_COLLAPSE_LINE_THRESHOLD + 1);
  return lines.length > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD;
}

export function buildCollapsedUserMessageText(text: string): string {
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
