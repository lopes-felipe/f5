/** Apply native presentation before text reaches transcript, preview, or search projections. */
export function codexMessagePresentation(value: unknown): {
  replace: boolean;
  text?: string;
  mode?: "show" | "hide" | "block";
} {
  if (!value || typeof value !== "object") return { replace: false };
  const item = value as Record<string, unknown>;
  if (!item.moderation || typeof item.moderation !== "object") return { replace: false };
  const moderation = item.moderation as Record<string, unknown>;
  const display = moderation.display;
  if (!display || typeof display !== "object") return { replace: false };
  const { mode, version } = display as Record<string, unknown>;
  if (version === 1 && mode === "show")
    return moderation.moderated === true
      ? { replace: true, mode, text: typeof item.text === "string" ? item.text : "" }
      : { replace: false, mode };
  // Unknown presentation versions must not reveal content they might suppress.
  return {
    replace: true,
    mode: mode === "hide" ? "hide" : "block",
    text:
      mode === "hide"
        ? "Codex has replaced this response with a wellbeing support notice."
        : "Codex blocked this response.",
  };
}

export function presentCodexMessageItem(value: unknown): unknown {
  const presentation = codexMessagePresentation(value);
  if (!presentation.replace) return value;
  const item = value as Record<string, unknown>;
  return {
    ...item,
    text: presentation.text,
    // Older history shapes may carry a second copy of the answer.
    content: undefined,
    output: undefined,
    result: undefined,
    message: undefined,
    questions: presentation.mode === "show" ? item.questions : null,
  };
}
