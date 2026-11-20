export interface PrCompletionTrigger {
  start: number;
  end: number;
  sigil: "@" | "#" | "!";
  query: string;
}

export function prCompletionTrigger(
  text: string,
  start: number,
  end = start,
): PrCompletionTrigger | null {
  if (start !== end) return null;
  const prefix = text.slice(0, start);
  // Whitespace and opening punctuation start a token; emails and URLs do not.
  const match = /(?:^|[\s([{])([@#!])([A-Za-z0-9_.-]{0,100})$/.exec(prefix);
  if (!match) return null;
  return {
    start: start - match[2]!.length - 1,
    end: start,
    sigil: match[1] as "@" | "#" | "!",
    query: match[2]!,
  };
}
