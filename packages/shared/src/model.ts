import {
  CLAUDE_CODE_EFFORT_OPTIONS,
  CODEX_REASONING_EFFORT_OPTIONS,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_REASONING_EFFORT_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  REASONING_EFFORT_OPTIONS_BY_PROVIDER,
  type ClaudeBuiltInModelSlug,
  type ClaudeModelOptions,
  type ClaudeCodeEffort,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type CursorModelOptions,
  type ModelCapabilities,
  type ModelServiceTier,
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
  grok: new Set(MODEL_OPTIONS_BY_PROVIDER.grok.map((option) => option.slug)),
  antigravity: new Set(MODEL_OPTIONS_BY_PROVIDER.antigravity.map((option) => option.slug)),
};

const CLAUDE_FABLE_5_MODEL = "claude-fable-5";
const CLAUDE_FABLE_5_1_MODEL = "claude-fable-5-1";
const CLAUDE_SONNET_5_MODEL = "claude-sonnet-5";
const CLAUDE_OPUS_5_5_MODEL = "claude-opus-5-5";
const CLAUDE_OPUS_5_MODEL = "claude-opus-5";
const CLAUDE_OPUS_4_8_MODEL = "claude-opus-4-8";
const CLAUDE_OPUS_4_7_MODEL = "claude-opus-4-7";
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
const CLAUDE_OPUS_4_5_MODEL = "claude-opus-4-5";
const CLAUDE_SONNET_4_6_MODEL = "claude-sonnet-4-6";
const CLAUDE_HAIKU_4_5_MODEL = "claude-haiku-4-5";
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;
export const CLAUDE_CONTEXT_WINDOW_OPTIONS = ["200k", "1m"] as const;
export type ClaudeContextWindow = (typeof CLAUDE_CONTEXT_WINDOW_OPTIONS)[number];
const CLAUDE_CONTEXT_WINDOW_TOKENS: Record<ClaudeContextWindow, number> = {
  "200k": 200_000,
  "1m": 1_000_000,
};

interface ClaudeModelMetadata {
  readonly contextWindowTokens: number;
  readonly effortOptions?: ReadonlyArray<ClaudeCodeEffort>;
  readonly defaultEffort?: Exclude<ClaudeCodeEffort, "ultrathink">;
  readonly supportsFastMode?: boolean;
  readonly supportsThinkingToggle?: boolean;
  readonly supportsContextWindow?: boolean;
}

const CLAUDE_MODEL_METADATA: Record<ClaudeBuiltInModelSlug, ClaudeModelMetadata> = {
  [CLAUDE_OPUS_5_5_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "medium",
    supportsFastMode: true,
  },
  [CLAUDE_OPUS_5_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "high",
    supportsFastMode: true,
  },
  [CLAUDE_FABLE_5_1_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "high",
  },
  [CLAUDE_FABLE_5_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "high",
    supportsContextWindow: true,
  },
  [CLAUDE_SONNET_5_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "high",
    supportsContextWindow: true,
  },
  [CLAUDE_OPUS_4_8_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "xhigh",
    supportsFastMode: true,
    supportsContextWindow: true,
  },
  [CLAUDE_OPUS_4_7_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: CLAUDE_CODE_EFFORT_OPTIONS,
    defaultEffort: "xhigh",
    supportsContextWindow: true,
  },
  [CLAUDE_OPUS_4_6_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "max", "ultrathink"],
    defaultEffort: "high",
    supportsContextWindow: true,
  },
  [CLAUDE_OPUS_4_5_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "max", "ultrathink"],
    defaultEffort: "high",
  },
  [CLAUDE_SONNET_4_6_MODEL]: {
    contextWindowTokens: 1_000_000,
    effortOptions: ["low", "medium", "high", "ultrathink"],
    defaultEffort: "high",
    supportsContextWindow: true,
  },
  [CLAUDE_HAIKU_4_5_MODEL]: {
    contextWindowTokens: 200_000,
    supportsThinkingToggle: true,
  },
};

interface CodexModelMetadata {
  readonly contextWindowTokens: number;
  readonly effortOptions?: ReadonlyArray<CodexReasoningEffort>;
  readonly defaultEffort?: CodexReasoningEffort;
}

const CODEX_MODEL_METADATA: Record<string, CodexModelMetadata> = {
  "gpt-6.1-sol": { contextWindowTokens: 1_050_000 },
  "gpt-6-astra": {
    contextWindowTokens: 1_050_000,
    effortOptions: ["max", "xhigh", "high", "medium", "low"],
  },
  "gpt-5.6-sol": { contextWindowTokens: 1_050_000 },
  "gpt-5.6-terra": { contextWindowTokens: 1_050_000 },
  "gpt-5.6-luna": { contextWindowTokens: 1_050_000 },
  "gpt-5.5": { contextWindowTokens: 1_050_000 },
  "gpt-5.4": { contextWindowTokens: 1_050_000 },
  "gpt-5.4-mini": { contextWindowTokens: 400_000 },
  "gpt-5.3-codex": { contextWindowTokens: 400_000 },
  "gpt-5.3-codex-spark": { contextWindowTokens: 400_000 },
  "gpt-5.2": { contextWindowTokens: 400_000 },
  "gpt-5.2-codex": { contextWindowTokens: 400_000 },
} satisfies Record<(typeof MODEL_OPTIONS_BY_PROVIDER.codex)[number]["slug"], CodexModelMetadata>;

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
    case "grok":
    case "antigravity":
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

export function normalizeClaudeContextWindow(
  value: string | null | undefined,
): ClaudeContextWindow | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "200k" || normalized === "1m" ? normalized : undefined;
}

export function getClaudeContextWindowTokens(
  contextWindow: string | null | undefined,
): number | undefined {
  const normalized = normalizeClaudeContextWindow(contextWindow);
  return normalized ? CLAUDE_CONTEXT_WINDOW_TOKENS[normalized] : undefined;
}

export function claudeModelOptionsToProviderOptionSelections(
  options: ClaudeModelOptions | null | undefined,
  model?: string | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!options) {
    return undefined;
  }
  const selections: ProviderOptionSelection[] = [];
  if (options.effort) {
    selections.push({ id: "effort", value: options.effort });
  }
  if (typeof options.thinking === "boolean") {
    selections.push({ id: "thinking", value: options.thinking });
  }
  if (typeof options.fastMode === "boolean") {
    selections.push({ id: "fastMode", value: options.fastMode });
  }
  const contextWindow =
    model === undefined || supportsClaudeContextWindow(model)
      ? normalizeClaudeContextWindow(options.contextWindow)
      : undefined;
  if (contextWindow) {
    selections.push({ id: "contextWindow", value: contextWindow });
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

const CLAUDE_EFFORT_LABELS: Record<ClaudeCodeEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultrathink: "Ultrathink",
};

/**
 * Build the provider-facing Claude option descriptors from the canonical
 * model metadata. Keeping this derivation shared prevents server snapshots
 * from drifting from the runtime capability predicates.
 */
export function createClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const metadata = getClaudeModelMetadata(model);
  if (!metadata) {
    return createModelCapabilities({ optionDescriptors: [] });
  }

  const optionDescriptors: ProviderOptionDescriptor[] = [];
  if (metadata.effortOptions && metadata.effortOptions.length > 0) {
    optionDescriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: metadata.effortOptions.map((effort) => ({
        id: effort,
        label: CLAUDE_EFFORT_LABELS[effort],
        ...(effort === metadata.defaultEffort ? { isDefault: true } : {}),
      })),
      ...(metadata.defaultEffort ? { currentValue: metadata.defaultEffort } : {}),
      ...(metadata.effortOptions.includes("ultrathink")
        ? { promptInjectedValues: ["ultrathink"] }
        : {}),
    });
  }
  if (metadata.supportsFastMode) {
    optionDescriptors.push({
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    });
  }
  if (metadata.supportsContextWindow) {
    optionDescriptors.push({
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k", isDefault: true },
        { id: "1m", label: "1M" },
      ],
      currentValue: "200k",
    });
  }
  if (metadata.supportsThinkingToggle) {
    optionDescriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    });
  }

  return createModelCapabilities({ optionDescriptors });
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
  return normalized && Object.prototype.hasOwnProperty.call(CLAUDE_MODEL_METADATA, normalized)
    ? CLAUDE_MODEL_METADATA[normalized as ClaudeBuiltInModelSlug]
    : undefined;
}

function lookupCodexModelMetadata(normalized: string): CodexModelMetadata | undefined {
  return Object.prototype.hasOwnProperty.call(CODEX_MODEL_METADATA, normalized)
    ? CODEX_MODEL_METADATA[normalized]
    : undefined;
}

function getCodexModelMetadata(model: string | null | undefined): CodexModelMetadata | undefined {
  const normalized = normalizeModelSlug(model, "codex");
  return normalized ? lookupCodexModelMetadata(normalized) : undefined;
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

/**
 * Adaptive-thinking support for thinking resolution: `undefined` when F5 has no
 * metadata for the model, so explicit configs are left to the runtime.
 */
export function claudeModelSupportsAdaptiveThinking(
  model: string | null | undefined,
): boolean | undefined {
  return getClaudeModelMetadata(model) ? supportsClaudeAdaptiveReasoning(model) : undefined;
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

export function supportsClaudeContextWindow(model: string | null | undefined): boolean {
  return getClaudeModelMetadata(model)?.supportsContextWindow === true;
}

function stripClaudeContextWindowSuffix(model: string): string {
  return model.replace(/\[(?:1m|200k)\]$/i, "");
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
  const slug =
    builtInProvider === "claudeAgent" ? stripClaudeContextWindowSuffix(trimmed) : trimmed;
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[builtInProvider] as Record<string, ModelSlug>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, slug) ? aliases[slug] : undefined;
  return typeof aliased === "string" ? aliased : (slug as ModelSlug);
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
    ? (getClaudeModelMetadata(normalized)?.contextWindowTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
    : (lookupCodexModelMetadata(normalized)?.contextWindowTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
}

export function getReasoningEffortOptions(
  provider: "codex",
  model?: string | null | undefined,
): ReadonlyArray<CodexReasoningEffort>;
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
  if (provider === "codex") {
    return (
      getCodexModelMetadata(model)?.effortOptions ?? REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex
    );
  }
  return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
}

export function getDefaultReasoningEffort(
  provider: "codex",
  model?: string | null | undefined,
): CodexReasoningEffort;
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
  if (provider === "codex") {
    const metadata = getCodexModelMetadata(model);
    const defaultEffort = metadata?.defaultEffort ?? DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex;
    return metadata?.effortOptions && !metadata.effortOptions.includes(defaultEffort)
      ? (metadata.effortOptions[0] ?? DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex)
      : defaultEffort;
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

export function resolveCodexReasoningEffortForModel(
  model: string | null | undefined,
  effort: string | null | undefined,
): CodexReasoningEffort {
  const supportedOptions = getReasoningEffortOptions("codex", model);
  const resolved = resolveReasoningEffortForProvider("codex", effort);
  if (resolved) {
    const requestedIndex = CODEX_REASONING_EFFORT_OPTIONS.indexOf(resolved);
    for (let index = requestedIndex; index < CODEX_REASONING_EFFORT_OPTIONS.length; index += 1) {
      const candidate = CODEX_REASONING_EFFORT_OPTIONS[index]!;
      if (supportedOptions.includes(candidate)) {
        return candidate;
      }
    }
  }
  return getDefaultReasoningEffort("codex", model);
}

export function normalizeCodexModelOptions(
  model: string | null | undefined,
  modelOptions: CodexModelOptions | null | undefined,
  /** The model's reported capabilities; when present they decide, as at `turn/start`. */
  reported?: ModelCapabilities | null,
): CodexModelOptions | undefined {
  if (reported?.source === "reported") {
    const capabilities = resolveModelCapabilities("codex", model, reported);
    const requested = modelOptions?.reasoningEffort;
    const effort =
      requested && capabilities.effortOptions.includes(requested) ? requested : undefined;
    const reportedOptions: CodexModelOptions = {
      ...(effort && effort !== capabilities.defaultEffort ? { reasoningEffort: effort } : {}),
      ...(modelOptions?.fastMode === true && capabilities.supportsFastMode
        ? { fastMode: true }
        : {}),
    };
    return Object.keys(reportedOptions).length > 0 ? reportedOptions : undefined;
  }
  const defaultReasoningEffort = getDefaultReasoningEffort("codex", model);
  const reasoningEffort = resolveCodexReasoningEffortForModel(model, modelOptions?.reasoningEffort);
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
  const contextWindow = supportsClaudeContextWindow(model)
    ? normalizeClaudeContextWindow(modelOptions?.contextWindow)
    : undefined;
  const nextOptions: ClaudeModelOptions = {
    ...(thinking === false ? { thinking: false } : {}),
    ...(effort ? { effort } : {}),
    ...(fastMode ? { fastMode: true } : {}),
    ...(contextWindow ? { contextWindow } : {}),
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

/**
 * Effective capabilities of one model, shared by the UI and the execution
 * paths so both agree on what a launch or turn may send.
 *
 * Executable-reported capabilities (`source: "reported"`) win over built-in
 * metadata for every fact the executable describes; facts it does not report
 * fall back to the built-in table, then to conservative defaults.
 */
export interface ResolvedModelCapabilities {
  readonly source: "reported" | "built-in" | "unknown";
  /** Efforts F5 may send for this model, in display order. */
  readonly effortOptions: ReadonlyArray<ProviderReasoningEffort>;
  readonly defaultEffort: ProviderReasoningEffort | undefined;
  /** Efforts applied through the prompt instead of an API option (Claude `ultrathink`). */
  readonly promptInjectedEfforts: ReadonlyArray<ProviderReasoningEffort>;
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
  readonly supportsContextWindow: boolean;
  /** `undefined` when neither the executable nor F5 metadata knows. */
  readonly supportsAdaptiveThinking: boolean | undefined;
  readonly supportsAutoMode: boolean | undefined;
  readonly serviceTiers: ReadonlyArray<ModelServiceTier>;
  readonly defaultServiceTier: string | undefined;
  readonly upgradeTo: string | undefined;
}

const CODEX_FAST_SERVICE_TIER = "fast";

function selectDescriptor(
  caps: ModelCapabilities | null | undefined,
  id: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  const descriptor = caps?.optionDescriptors?.find((candidate) => candidate.id === id);
  return descriptor?.type === "select" ? descriptor : undefined;
}

function hasDescriptor(caps: ModelCapabilities | null | undefined, id: string): boolean {
  return caps?.optionDescriptors?.some((candidate) => candidate.id === id) === true;
}

function knownEfforts<T extends ProviderReasoningEffort>(
  values: ReadonlyArray<string>,
  allowed: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return allowed.filter((effort) => values.includes(effort));
}

function descriptorDefault(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
): string | undefined {
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

export function resolveModelCapabilities(
  provider: ProviderKind | ProviderDriverKind,
  slug: string | null | undefined,
  reported?: ModelCapabilities | null,
): ResolvedModelCapabilities {
  const isReported = reported?.source === "reported";
  const reportedCaps = isReported ? reported : undefined;
  const base = {
    serviceTiers: reportedCaps?.serviceTiers ?? [],
    defaultServiceTier: reportedCaps?.defaultServiceTier,
    upgradeTo: reportedCaps?.upgradeTo,
    supportsAutoMode: reportedCaps?.supportsAutoMode,
  };

  if (provider === "claudeAgent") {
    const metadata = getClaudeModelMetadata(slug);
    const effortDescriptor = selectDescriptor(reportedCaps, "effort");
    const builtInEfforts = metadata?.effortOptions ?? [];
    // An explicit "no effort" report wins; an unreported list keeps F5's.
    const effortOptions: ReadonlyArray<ClaudeCodeEffort> =
      reportedCaps?.supportsEffort === false
        ? []
        : effortDescriptor
          ? knownEfforts(
              [
                ...effortDescriptor.options.map((option) => option.id),
                // The prompt keyword is F5 metadata; executables never report it.
                ...(builtInEfforts.includes("ultrathink") ? ["ultrathink"] : []),
              ],
              CLAUDE_CODE_EFFORT_OPTIONS,
            )
          : builtInEfforts;
    const reportedDefault = effortDescriptor ? descriptorDefault(effortDescriptor) : undefined;
    const defaultEffort =
      reportedDefault && effortOptions.includes(reportedDefault as ClaudeCodeEffort)
        ? (reportedDefault as ClaudeCodeEffort)
        : metadata?.defaultEffort && effortOptions.includes(metadata.defaultEffort)
          ? metadata.defaultEffort
          : effortOptions.includes(DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent)
            ? DEFAULT_REASONING_EFFORT_BY_PROVIDER.claudeAgent
            : undefined;
    return {
      ...base,
      source: reportedCaps ? "reported" : metadata ? "built-in" : "unknown",
      effortOptions,
      defaultEffort,
      promptInjectedEfforts: effortOptions.includes("ultrathink") ? ["ultrathink"] : [],
      supportsFastMode: reportedCaps
        ? (reportedCaps.supportsFastMode ??
          (hasDescriptor(reportedCaps, "fastMode") || metadata?.supportsFastMode === true))
        : metadata?.supportsFastMode === true,
      supportsThinkingToggle: reportedCaps
        ? hasDescriptor(reportedCaps, "thinking")
        : metadata?.supportsThinkingToggle === true,
      // The SDK does not report extended context windows; only F5 metadata does.
      supportsContextWindow: metadata?.supportsContextWindow === true,
      supportsAdaptiveThinking:
        reportedCaps?.supportsAdaptiveThinking ??
        (metadata ? builtInEfforts.length > 0 : undefined),
    };
  }

  if (provider === "codex") {
    const metadata = getCodexModelMetadata(slug);
    const effortDescriptor = selectDescriptor(reportedCaps, "reasoningEffort");
    const effortOptions: ReadonlyArray<CodexReasoningEffort> =
      reportedCaps?.supportsEffort === false
        ? []
        : effortDescriptor
          ? knownEfforts(
              effortDescriptor.options.map((option) => option.id),
              CODEX_REASONING_EFFORT_OPTIONS,
            )
          : (metadata?.effortOptions ?? REASONING_EFFORT_OPTIONS_BY_PROVIDER.codex);
    const reportedDefault = effortDescriptor ? descriptorDefault(effortDescriptor) : undefined;
    const builtInDefault = getDefaultReasoningEffort("codex", slug);
    const defaultEffort =
      reportedDefault && effortOptions.includes(reportedDefault as CodexReasoningEffort)
        ? (reportedDefault as CodexReasoningEffort)
        : effortOptions.includes(builtInDefault)
          ? builtInDefault
          : effortOptions[0];
    // `undefined` when the model has no effort at all.
    return {
      ...base,
      source: reportedCaps ? "reported" : metadata ? "built-in" : "unknown",
      effortOptions,
      defaultEffort,
      promptInjectedEfforts: [],
      // Reported models advertise fast mode as a service tier; when tiers were
      // not reported, built-ins keep the historical always-available toggle.
      supportsFastMode: reportedCaps?.supportsFastMode ?? true,
      supportsThinkingToggle: false,
      supportsContextWindow: false,
      supportsAdaptiveThinking: undefined,
    };
  }

  const effortOptions =
    provider in REASONING_EFFORT_OPTIONS_BY_PROVIDER
      ? REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider as ProviderKind]
      : [];
  return {
    ...base,
    source: reportedCaps ? "reported" : "unknown",
    effortOptions,
    defaultEffort:
      effortOptions.length > 0 ? DEFAULT_REASONING_EFFORT_BY_PROVIDER.codex : undefined,
    promptInjectedEfforts: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    supportsContextWindow: false,
    supportsAdaptiveThinking: undefined,
  };
}

/** Resolve a requested effort to one the model supports, or `null` when none applies. */
export function resolveSupportedEffort(
  capabilities: ResolvedModelCapabilities,
  requested: string | null | undefined,
): ProviderReasoningEffort | null {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (trimmed && capabilities.effortOptions.includes(trimmed as ProviderReasoningEffort)) {
    return trimmed as ProviderReasoningEffort;
  }
  return null;
}

/** Subset of the SDK's `ModelInfo` that F5 reads. */
export interface ReportedClaudeModelInfo {
  readonly value: string;
  readonly displayName?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
}

/**
 * Capabilities for a Claude model described by SDK initialization. Only
 * facts the SDK reports are encoded; `resolveModelCapabilities` merges the
 * rest from F5 metadata.
 */
export function createReportedClaudeModelCapabilities(
  info: ReportedClaudeModelInfo,
): ModelCapabilities {
  const builtIn = createClaudeModelCapabilities(info.value);
  const builtInEffort = selectDescriptor(builtIn, "effort");
  const efforts = knownEfforts(info.supportedEffortLevels ?? [], CLAUDE_CODE_EFFORT_OPTIONS);
  const builtInDefault = builtInEffort ? descriptorDefault(builtInEffort) : undefined;
  const defaultEffort =
    builtInDefault && efforts.includes(builtInDefault as ClaudeCodeEffort)
      ? builtInDefault
      : efforts.includes("high")
        ? "high"
        : efforts[0];
  const optionDescriptors: ProviderOptionDescriptor[] = [];
  if (info.supportsEffort === false) {
    // Explicitly no effort: no descriptor, and the resolver sends none.
  } else if (efforts.length === 0) {
    // Levels not reported: keep F5's own effort choices for this model.
    if (builtInEffort) optionDescriptors.push(builtInEffort);
  } else {
    const withKeyword = builtInEffort?.promptInjectedValues?.includes("ultrathink")
      ? [...efforts, "ultrathink" as const]
      : efforts;
    optionDescriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: withKeyword.map((effort) => ({
        id: effort,
        label: CLAUDE_EFFORT_LABELS[effort],
        ...(effort === defaultEffort ? { isDefault: true } : {}),
      })),
      ...(defaultEffort ? { currentValue: defaultEffort } : {}),
      ...(withKeyword.includes("ultrathink") ? { promptInjectedValues: ["ultrathink"] } : {}),
    });
  }
  if (info.supportsFastMode === true) {
    optionDescriptors.push({ id: "fastMode", label: "Fast Mode", type: "boolean" });
  } else if (info.supportsFastMode === undefined) {
    // Unreported: F5 metadata decides (the SDK field is optional).
    const builtInFast = builtIn.optionDescriptors?.find((entry) => entry.id === "fastMode");
    if (builtInFast) optionDescriptors.push(builtInFast);
  }
  // Context-window choices are F5 metadata the SDK does not report.
  const contextWindow = builtIn.optionDescriptors?.find((entry) => entry.id === "contextWindow");
  if (contextWindow) optionDescriptors.push(contextWindow);
  // Models without effort levels keep the classic extended-thinking toggle.
  const thinking = builtIn.optionDescriptors?.find((entry) => entry.id === "thinking");
  if (thinking) optionDescriptors.push(thinking);
  else if (info.supportsEffort === false && info.supportsAdaptiveThinking !== true) {
    optionDescriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    });
  }
  return {
    optionDescriptors,
    source: "reported",
    ...(info.supportsEffort !== undefined ? { supportsEffort: info.supportsEffort } : {}),
    ...(info.supportsFastMode !== undefined ? { supportsFastMode: info.supportsFastMode } : {}),
    ...(info.supportsAdaptiveThinking !== undefined
      ? { supportsAdaptiveThinking: info.supportsAdaptiveThinking }
      : {}),
    ...(info.supportsAutoMode !== undefined ? { supportsAutoMode: info.supportsAutoMode } : {}),
  };
}

/** Subset of Codex `model/list` `Model` entries that F5 reads. */
export interface ReportedCodexModelInfo {
  readonly model: string;
  readonly supportedReasoningEfforts?: ReadonlyArray<{ readonly reasoningEffort?: unknown }>;
  readonly defaultReasoningEffort?: unknown;
  readonly serviceTiers?: ReadonlyArray<{
    readonly id?: unknown;
    readonly name?: unknown;
    readonly description?: unknown;
  }>;
  readonly defaultServiceTier?: unknown;
  readonly upgrade?: unknown;
}

const CODEX_EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
  ultra: "Ultra",
  max: "Max",
  xhigh: "Extra High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Capabilities for a Codex model described by `model/list`. Service tiers come
 * only from `serviceTiers`; the deprecated `additionalSpeedTiers` is ignored.
 */
export function createReportedCodexModelCapabilities(
  info: ReportedCodexModelInfo,
): ModelCapabilities {
  const effortsReported = Array.isArray(info.supportedReasoningEfforts);
  const tiersReported = Array.isArray(info.serviceTiers);
  const efforts = knownEfforts(
    (info.supportedReasoningEfforts ?? []).flatMap((entry) => {
      const effort = nonEmptyString(entry?.reasoningEffort);
      return effort ? [effort] : [];
    }),
    CODEX_REASONING_EFFORT_OPTIONS,
  );
  const reportedDefault = nonEmptyString(info.defaultReasoningEffort);
  const defaultEffort =
    reportedDefault && efforts.includes(reportedDefault as CodexReasoningEffort)
      ? reportedDefault
      : efforts[0];
  const serviceTiers = (info.serviceTiers ?? []).flatMap((tier): ModelServiceTier[] => {
    const id = nonEmptyString(tier?.id);
    if (!id) return [];
    const description = nonEmptyString(tier?.description);
    return [
      { id, name: nonEmptyString(tier?.name) ?? id, ...(description ? { description } : {}) },
    ];
  });
  const defaultServiceTier = nonEmptyString(info.defaultServiceTier);
  const upgradeTo = nonEmptyString(info.upgrade);
  return {
    optionDescriptors:
      efforts.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: efforts.map((effort) => ({
                id: effort,
                label: CODEX_EFFORT_LABELS[effort],
                ...(effort === defaultEffort ? { isDefault: true } : {}),
              })),
              ...(defaultEffort ? { currentValue: defaultEffort } : {}),
            },
          ]
        : [],
    source: "reported",
    // A reported empty list means "none"; an absent field leaves F5's defaults.
    ...(effortsReported ? { supportsEffort: efforts.length > 0 } : {}),
    ...(tiersReported
      ? { supportsFastMode: serviceTiers.some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) }
      : {}),
    ...(serviceTiers.length > 0 ? { serviceTiers } : {}),
    ...(defaultServiceTier ? { defaultServiceTier } : {}),
    ...(upgradeTo && upgradeTo !== info.model ? { upgradeTo } : {}),
  };
}

export { CLAUDE_CODE_EFFORT_OPTIONS, CODEX_REASONING_EFFORT_OPTIONS };
