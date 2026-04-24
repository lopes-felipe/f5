import {
  type ClaudeCodeEffort,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  type CodexReasoningEffort,
  type ProviderKind,
  type ProviderModelOptions,
} from "@t3tools/contracts";

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: {
    effort?: CodexReasoningEffort | null;
    codexFastMode?: boolean | null;
    serviceTier?: string | null;
  },
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate =
    candidate?.codex && typeof candidate.codex === "object"
      ? (candidate.codex as Record<string, unknown>)
      : null;
  const claudeCandidate =
    candidate?.claudeAgent && typeof candidate.claudeAgent === "object"
      ? (candidate.claudeAgent as Record<string, unknown>)
      : null;

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true ||
    (provider === "codex" && legacy?.codexFastMode === true) ||
    legacy?.serviceTier === "fast";
  const codex =
    codexReasoningEffort && codexReasoningEffort !== DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex
      ? {
          reasoningEffort: codexReasoningEffort,
          ...(codexFastMode ? { fastMode: true } : {}),
        }
      : codexFastMode
        ? { fastMode: true }
        : undefined;

  const claudeThinking = claudeCandidate?.thinking === false ? false : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "xhigh" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode = claudeCandidate?.fastMode === true;
  const claude =
    claudeThinking === false || claudeEffort !== undefined || claudeFastMode
      ? {
          ...(claudeThinking === false ? { thinking: false } : {}),
          ...(claudeEffort ? { effort: claudeEffort } : {}),
          ...(claudeFastMode ? { fastMode: true } : {}),
        }
      : undefined;

  if (!codex && !claude) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
  };
}
