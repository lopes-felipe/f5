interface MessageText {
  readonly text: string;
  readonly reasoningText?: string | undefined;
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
