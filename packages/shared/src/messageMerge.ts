interface MessageText {
  readonly text: string;
  readonly reasoningText?: string | undefined;
}

export function boundMobileMessageText(text: string) {
  const byteLimit = 64 * 1024;
  if (text.length * 6 + 2 <= byteLimit) return { text };
  let bytes = 0;
  for (const character of JSON.stringify(text)) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > byteLimit) {
      return {
        text:
          text.slice(0, Math.floor((byteLimit - 80) / 6)) +
          "\n[Open on the host for the full text]",
        truncated: true as const,
      };
    }
  }
  return { text };
}

export function mergeMessageText(
  existing: MessageText | undefined,
  patch: MessageText & { readonly streaming: boolean; readonly replace?: boolean | undefined },
) {
  function merge(previous: string | undefined, next: string | undefined) {
    if (patch.replace) return next;
    if (next === undefined) return previous;
    if (!existing) return next;
    if (patch.streaming) return (previous ?? "") + next;
    return next.length === 0 ? previous : next;
  }

  const reasoningText = merge(existing?.reasoningText, patch.reasoningText);
  return {
    text: merge(existing?.text, patch.text) ?? "",
    ...(reasoningText !== undefined ? { reasoningText } : {}),
  };
}
