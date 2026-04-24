import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type ClaudeModelOptions,
  type ClaudeCodeEffort,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type ModelSlug,
  type ProviderReasoningEffort,
  type ProviderKind,
} from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
};

const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

interface ClaudeModelMetadata {
  readonly contextWindowTokens: number;
  readonly effortOptions?: ReadonlyArray<ClaudeCodeEffort>;
  readonly defaultEffort?: Exclude<ClaudeCodeEffort, "ultrathink">;
  readonly supportsFastMode?: boolean;
  readonly supportsThinkingToggle?: boolean;
}

const CLAUDE_MODEL_METADATA: Record<string, ClaudeModelMetadata> = {
  [CLAUDE_OPUS_4_7_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "xhigh", "max", "ultrathink"],
    defaultEffort: "xhigh",
  },
  [CLAUDE_OPUS_4_6_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "max", "ultrathink"],
    defaultEffort: "high",
    supportsFastMode: true,
  },
  [CLAUDE_SONNET_4_6_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "ultrathink"],
    defaultEffort: "high",
  },
  [CLAUDE_HAIKU_4_5_MODEL]: {
    contextWindowTokens: 200_000,
    supportsThinkingToggle: true,
  },
};

const CODEX_MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.3-codex-spark": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.2-codex": 400_000,
};

export function roughTokenEstimateFromCharacters(characters: number): number {
  return Math.max(0, Math.ceil(Math.max(0, characters) / 4));
}

function signedTokenEstimateFromCharacters(characters: number): number {
  if (!Number.isFinite(characters) || characters === 0) {
    return 0;
  }
  if (characters > 0) {
    return Math.ceil(characters / 4);
  }
  return -Math.ceil(Math.abs(characters) / 4);
}

export function estimateMessageContextCharacters(input: {
  readonly text: string | null | undefined;
  readonly reasoningText?: string | null | undefined;
  readonly attachmentNames?: ReadonlyArray<string> | null | undefined;
}): number {
  return (
    (input.text?.length ?? 0) +
    (input.reasoningText?.length ?? 0) +
    (input.attachmentNames?.join(", ").length ?? 0)
  );
}

export function estimateContextTokensAfterMessageUpdate(input: {
  readonly previousEstimatedContextTokens: number | null | undefined;
  readonly previousMessageCharacters?: number | null | undefined;
  readonly nextMessageCharacters: number;
  readonly fallbackTotalCharacters?: number | null | undefined;
}): number {
  if (
    input.previousEstimatedContextTokens !== null &&
    input.previousEstimatedContextTokens !== undefined
  ) {
    return Math.max(
      0,
      input.previousEstimatedContextTokens +
        signedTokenEstimateFromCharacters(
          input.nextMessageCharacters - (input.previousMessageCharacters ?? 0),
        ),
    );
  }

  return roughTokenEstimateFromCharacters(
    input.fallbackTotalCharacters ?? input.nextMessageCharacters,
  );
}

export function getModelOptions(provider: ProviderKind = "codex") {
  return MODEL_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultModel(provider: ProviderKind = "codex"): ModelSlug {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

function getClaudeModelMetadata(model: string | null | undefined): ClaudeModelMetadata | undefined {
  const normalized = normalizeModelSlug(model, "claudeAgent");
  return normalized ? CLAUDE_MODEL_METADATA[normalized] : undefined;
}

function getClaudeReasoningEffortOptions(
  model: string | null | undefined,
): ReadonlyArray<ClaudeCodeEffort> {
  return getClaudeModelMetadata(model)?.effortOptions ?? [];
}

export function supportsClaudeFastMode(model: string | null | undefined): boolean {
  return getClaudeModelMetadata(model)?.supportsFastMode === true;
}

export function supportsClaudeAdaptiveReasoning(model: string | null | undefined): boolean {
  return getClaudeReasoningEffortOptions(model).length > 0;
}

export function supportsClaudeMaxEffort(model: string | null | undefined): boolean {
  return getClaudeReasoningEffortOptions(model).includes("max");
}

export function supportsClaudeUltrathinkKeyword(model: string | null | undefined): boolean {
  return getClaudeReasoningEffortOptions(model).includes("ultrathink");
}

export function supportsClaudeThinkingToggle(model: string | null | undefined): boolean {
  return getClaudeModelMetadata(model)?.supportsThinkingToggle === true;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): ModelSlug {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return getDefaultModel(provider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[provider].has(normalized)
    ? normalized
    : getDefaultModel(provider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function inferProviderForModel(
  model: string | null | undefined,
  fallback: ProviderKind = "codex",
): ProviderKind {
  const normalizedClaude = normalizeModelSlug(model, "claudeAgent");
  if (normalizedClaude && MODEL_SLUG_SET_BY_PROVIDER.claudeAgent.has(normalizedClaude)) {
    return "claudeAgent";
  }

  const normalizedCodex = normalizeModelSlug(model, "codex");
  if (normalizedCodex && MODEL_SLUG_SET_BY_PROVIDER.codex.has(normalizedCodex)) {
    return "codex";
  }

  return typeof model === "string" && model.trim().startsWith("claude-") ? "claudeAgent" : fallback;
}

export function estimateModelContextWindowTokens(
  model: string | null | undefined,
  provider?: ProviderKind,
): number {
  const resolvedProvider = provider ?? inferProviderForModel(model, "codex");
  const normalized = normalizeModelSlug(model, resolvedProvider);
  if (!normalized) {
    return DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  }

  return resolvedProvider === "claudeAgent"
    ? (CLAUDE_MODEL_METADATA[normalized]?.contextWindowTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
    : (CODEX_MODEL_CONTEXT_WINDOW_TOKENS[normalized] ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
}

export function getReasoningEffortOptions(provider: "codex"): ReadonlyArray<CodexReasoningEffort>;
export function getReasoningEffortOptions(
  provider: "claudeAgent",
  model?: string | null | undefined,
): ReadonlyArray<ClaudeCodeEffort>;
export function getReasoningEffortOptions(
  provider?: ProviderKind,
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort>;
export function getReasoningEffortOptions(
  provider: ProviderKind = "codex",
  model?: string | null | undefined,
): ReadonlyArray<ProviderReasoningEffort> {
  if (provider === "claudeAgent") {
    return getClaudeReasoningEffortOptions(model);
  }
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(provider: "codex"): CodexReasoningEffort;
export function getDefaultReasoningEffort(
  provider: "claudeAgent",
  model?: string | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink">;
export function getDefaultReasoningEffort(
  provider?: ProviderKind,
  model?: string | null | undefined,
): ProviderReasoningEffort;
export function getDefaultReasoningEffort(
  provider: ProviderKind = "codex",
  model?: string | null | undefined,
): ProviderReasoningEffort {
  if (provider === "claudeAgent") {
    const metadata = getClaudeModelMetadata(model);
    const defaultEffort =
      metadata?.defaultEffort ?? DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent;
    return metadata?.effortOptions?.includes(defaultEffort)
      ? defaultEffort
      : DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent;
  }
  return DEFAULT_REASONING_EFFORT_BY_PROVIDER[provider];
}

export function resolveReasoningEffortForProvider(
  provider: "codex",
  effort: string | null | undefined,
): CodexReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: "claudeAgent",
  effort: string | null | undefined,
): ClaudeCodeEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null;
export function resolveReasoningEffortForProvider(
  provider: ProviderKind,
  effort: string | null | undefined,
): ProviderReasoningEffort | null {
  if (typeof effort !== "string") {
    return null;
  }

  const trimmed = effort.trim();
  if (!trimmed) {
    return null;
  }

  const options = REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider] as ReadonlyArray<string>;
  return options.includes(trimmed) ? (trimmed as ProviderReasoningEffort) : null;
}

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

export function normalizeCodexModelOptions(
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const defaultReasoningEffort = getDefaultReasoningEffort("codex");
  const reasoningEffort =
    resolveReasoningEffortForProvider("codex", modelOptions?.reasoningEffort) ??
    defaultReasoningEffort;
  const fastModeEnabled = modelOptions?.fastMode === true;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort !== defaultReasoningEffort ? { reasoningEffort } : {}),
    ...(fastModeEnabled ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptions(
  model: string | null | undefined,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const reasoningOptions = getReasoningEffortOptions("claudeAgent", model);
  const defaultReasoningEffort = getDefaultReasoningEffort("claudeAgent", model);
  const resolvedEffort = resolveReasoningEffortForProvider("claudeAgent", modelOptions?.effort);
  const effort =
    resolvedEffort &&
    resolvedEffort !== "ultrathink" &&
    reasoningOptions.includes(resolvedEffort) &&
    resolvedEffort !== defaultReasoningEffort
      ? resolvedEffort
      : undefined;
  const thinking =
    supportsClaudeThinkingToggle(model) && modelOptions?.thinking === false ? false : undefined;
  const fastMode =
    supportsClaudeFastMode(model) && modelOptions?.fastMode === true ? true : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}

export { CLAUDE_CODE_EFFORT_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS };
