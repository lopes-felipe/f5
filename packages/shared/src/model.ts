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
  type CursorModelOptions,
  type ModelCapabilities,
  type ModelSelection,
  type ModelSlug,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ProviderReasoningEffort,
  type ProviderKind,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

const MODEL_SLUG_SET_BY_PROVIDER: Record<ProviderKind, ReadonlySet<ModelSlug>> = {
  claudeAgent: new Set(MODEL_OPTIONS_BY_PROVIDER.claudeAgent.map((option) => option.slug)),
  codex: new Set(MODEL_OPTIONS_BY_PROVIDER.codex.map((option) => option.slug)),
  cursor: new Set(MODEL_OPTIONS_BY_PROVIDER.cursor.map((option) => option.slug)),
  opencode: new Set(MODEL_OPTIONS_BY_PROVIDER.opencode.map((option) => option.slug)),
};

const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_OPUS_4_5_MODEL = "claude-opus-4-5";
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
  [CLAUDE_OPUS_4_5_MODEL]: {
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
  "gpt-5.5": 1_050_000,
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

function toBuiltInProviderKind(provider: ProviderKind | ProviderDriverKind): ProviderKind {
  switch (provider) {
    case "codex":
    case "claudeAgent":
    case "cursor":
    case "opencode":
      return provider as ProviderKind;
    default:
      return "codex";
  }
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  return {
    instanceId,
    model,
    ...(options && options.length > 0
      ? { options: options.map((selection) => ({ ...selection })) }
      : {}),
  };
}

export function cursorModelOptionsToProviderOptionSelections(
  options: CursorModelOptions | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!options) {
    return undefined;
  }
  const selections: ProviderOptionSelection[] = [];
  if (options.reasoning) {
    selections.push({ id: "reasoning", value: options.reasoning });
  }
  if (typeof options.thinking === "boolean") {
    selections.push({ id: "thinking", value: options.thinking });
  }
  if (typeof options.fastMode === "boolean") {
    selections.push({ id: "fastMode", value: options.fastMode });
  }
  if (typeof options.contextWindow === "string" && options.contextWindow.trim().length > 0) {
    selections.push({ id: "contextWindow", value: options.contextWindow.trim() });
  }
  return selections.length > 0 ? selections : undefined;
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneProviderOptionDescriptor),
  };
}

function cloneProviderOptionDescriptor(
  descriptor: ProviderOptionDescriptor,
): ProviderOptionDescriptor {
  if (descriptor.type === "select") {
    return {
      ...descriptor,
      options: descriptor.options.map((option) => ({ ...option })),
      ...(descriptor.promptInjectedValues
        ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
        : {}),
    };
  }
  return { ...descriptor };
}

export function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return selections?.find((selection) => selection.id === id)?.value;
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) return undefined;
  const value = getProviderOptionCurrentValue(descriptor);
  if (descriptor.type === "boolean") {
    return typeof value === "boolean" ? (value ? "On" : "Off") : undefined;
  }
  return descriptor.options.find((option) => option.id === value)?.label;
}

function resolveSelectDescriptorValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities | null | undefined;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  return (input.caps?.optionDescriptors ?? []).map((descriptor) => {
    if (descriptor.type === "boolean") {
      const selected = getProviderOptionBooleanSelectionValue(input.selections, descriptor.id);
      return {
        ...descriptor,
        ...(selected !== undefined ? { currentValue: selected } : {}),
      };
    }
    const selected = getProviderOptionStringSelectionValue(input.selections, descriptor.id);
    return {
      ...descriptor,
      options: descriptor.options.map((option) => ({ ...option })),
      ...(descriptor.promptInjectedValues
        ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
        : {}),
      currentValue: resolveSelectDescriptorValue(descriptor, selected),
    };
  });
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const selections: ProviderOptionSelection[] = [];
  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      selections.push({ id: descriptor.id, value });
    }
  }
  return selections.length > 0 ? selections : undefined;
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
  provider: ProviderKind | ProviderDriverKind = "codex",
): ModelSlug | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const builtInProvider = toBuiltInProviderKind(provider);
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[builtInProvider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : (trimmed as ModelSlug);
}

export function resolveModelSlug(
  model: string | null | undefined,
  provider: ProviderKind | ProviderDriverKind = "codex",
): ModelSlug {
  const builtInProvider = toBuiltInProviderKind(provider);
  const normalized = normalizeModelSlug(model, builtInProvider);
  if (!normalized) {
    return getDefaultModel(builtInProvider);
  }

  return MODEL_SLUG_SET_BY_PROVIDER[builtInProvider].has(normalized)
    ? normalized
    : getDefaultModel(builtInProvider);
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelSlug {
  return resolveModelSlug(model, provider);
}

export function resolveSelectableModel(
  provider: ProviderKind | ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<{ slug: string; name: string }>,
): ModelSlug | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
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
