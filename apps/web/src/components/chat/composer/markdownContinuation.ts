export interface MarkdownContinuation {
  readonly removeBefore: number;
  readonly text: string;
}

/** Continue Markdown on an intentional newline without changing existing text. */
export function markdownContinuation(value: string, cursor: number): MarkdownContinuation | null {
  const before = value.slice(0, cursor);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  let fence: { marker: string; quoteDepth: number } | undefined;
  for (const previous of before.split("\n").slice(0, -1)) {
    const container = previous.match(/^[ \t]*(?:>[ \t]*)+/)?.[0] ?? "";
    const quoteDepth = (container.match(/>/g) ?? []).length;
    // Leaving a quote also leaves its fenced block.
    if (fence && quoteDepth < fence.quoteDepth) fence = undefined;
    const match = previous.slice(container.length).match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1]!;
    if (!fence) {
      if (marker[0] === "`" && match[2]!.includes("`")) continue;
      fence = { marker, quoteDepth };
    } else if (
      quoteDepth === fence.quoteDepth &&
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      !match[2]!.trim()
    )
      fence = undefined;
  }
  const currentQuoteDepth = (line.match(/^[ \t]*(?:>[ \t]*)+/)?.[0].match(/>/g) ?? []).length;
  if (fence && currentQuoteDepth < fence.quoteDepth) fence = undefined;
  if (fence) return null;
  const quote = line.match(/^([ \t]*(?:>[ \t]*)+)/)?.[0] ?? "";
  const body = line.slice(quote.length);
  const list = body.match(/^([ \t]*)(?:(\d+)([.)])|([-+*]))([ \t]+|$)(.*)$/);
  if (list) {
    const [, indent = "", number, delimiter, bullet, spacing = "", content = ""] = list;
    const task = content.match(/^\[[ xX]\](?:[ \t]+|$)(.*)$/);
    const empty = task ? !task[1]?.trim() : !content.trim();
    if (empty && !value.slice(cursor).split("\n")[0]?.trim() && (spacing.length > 0 || task)) {
      return { removeBefore: line.length, text: quote + indent };
    }
    const nextNumber = number ? Number(number) + 1 : undefined;
    if (nextNumber !== undefined && !Number.isSafeInteger(nextNumber)) return null;
    const marker = number ? `${nextNumber}${delimiter}` : bullet;
    return { removeBefore: 0, text: `\n${quote}${indent}${marker} ${task ? "[ ] " : ""}` };
  }
  if (quote) {
    return body.trim()
      ? { removeBefore: 0, text: "\n" + quote }
      : { removeBefore: line.length, text: "" };
  }
  const indent = line.match(/^[ \t]+/)?.[0];
  return indent ? { removeBefore: 0, text: "\n" + indent } : null;
}
