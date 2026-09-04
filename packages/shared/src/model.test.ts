import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ProviderKind,
} from "@t3tools/contracts";

import {
  claudeModelOptionsToProviderOptionSelections,
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  estimateContextTokensAfterMessageUpdate,
  estimateModelContextWindowTokens,
  estimateMessageContextCharacters,
  getClaudeContextWindowTokens,
  getDefaultModel,
  getEffectiveClaudeCodeEffort,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeClaudeModelOptions,
  normalizeClaudeContextWindow,
  normalizeModelSlug,
  roughTokenEstimateFromCharacters,
  resolveSelectableModel,
  resolveCodexReasoningEffortForModel,
  resolveModelSlug,
  supportsClaudeAdaptiveReasoning,
  supportsClaudeContextWindow,
  supportsClaudeFastMode,
  supportsClaudeMaxEffort,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeModelSlug("5.5")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("fable", "claudeAgent")).toBe("claude-fable-5");
    expect(normalizeModelSlug("fable-5", "claudeAgent")).toBe("claude-fable-5");
    expect(normalizeModelSlug("claude-fable", "claudeAgent")).toBe("claude-fable-5");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("sonnet-5", "claudeAgent")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("claude-sonnet-5.0", "claudeAgent")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("claude-sonnet-5-0", "claudeAgent")).toBe("claude-sonnet-5");
    expect(normalizeModelSlug("sonnet-4.6", "claudeAgent")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-5", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("claude-opus-5.0", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("claude-opus-5-0", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("opus-4.8", "claudeAgent")).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("claude-opus-4.8", "claudeAgent")).toBe("claude-opus-4-8");
    expect(normalizeModelSlug("opus-4.6", "claudeAgent")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("opus-4.5", "claudeAgent")).toBe("claude-opus-4-5");
    expect(normalizeModelSlug("claude-opus-4.5", "claudeAgent")).toBe("claude-opus-4-5");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("strips Claude Code context-window suffixes from Claude model slugs", () => {
    expect(normalizeModelSlug("claude-fable-5[1m]", "claudeAgent")).toBe("claude-fable-5");
    expect(normalizeModelSlug("claude-fable-5[200k]", "claudeAgent")).toBe("claude-fable-5");
    expect(normalizeModelSlug("opus-5[1m]", "claudeAgent")).toBe("claude-opus-5");
    expect(normalizeModelSlug("claude-opus-5[200k]", "claudeAgent")).toBe("claude-opus-5");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });

  it("makes Claude Opus 5 the Claude default while exposing prior releases", () => {
    expect(getDefaultModel("claudeAgent")).toBe(DEFAULT_MODEL_BY_PROVIDER.claudeAgent);
    expect(DEFAULT_MODEL_BY_PROVIDER.claudeAgent).toBe("claude-opus-5");
    expect(getModelOptions("claudeAgent").map((option) => option.slug)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });

  it("makes GPT-6 Astra the Codex default and first catalog entry", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER.codex).toBe("gpt-6-astra");
    expect(getModelOptions("codex").map((option) => option.slug)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
    ]);
  });
});

describe("resolveSelectableModel", () => {
  const options = [
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "custom/internal-model", name: "Internal Model" },
  ];

  it("resolves exact slugs before names or aliases", () => {
    expect(resolveSelectableModel("codex", "custom/internal-model", options)).toBe(
      "custom/internal-model",
    );
  });

  it("resolves option names case-insensitively", () => {
    expect(resolveSelectableModel("codex", "internal model", options)).toBe(
      "custom/internal-model",
    );
  });

  it("normalizes aliases before checking available options", () => {
    expect(resolveSelectableModel("codex", "5.3", options)).toBe("gpt-5.3-codex");
  });

  it("rejects missing, empty, or unavailable values", () => {
    expect(resolveSelectableModel("codex", null, options)).toBeNull();
    expect(resolveSelectableModel("codex", "   ", options)).toBeNull();
    expect(resolveSelectableModel("codex", "gpt-5.5", options)).toBeNull();
  });
});

describe("model catalog invariants", () => {
  const providers = Object.keys(MODEL_OPTIONS_BY_PROVIDER) as ProviderKind[];
  const defaultMaps = [
    DEFAULT_MODEL_BY_PROVIDER,
    DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
    DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ] as const;

  it.each(providers)("keeps %s built-in slugs unique and round-trippable", (provider) => {
    const slugs = MODEL_OPTIONS_BY_PROVIDER[provider].map((model) => model.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(normalizeModelSlug(slug, provider)).toBe(slug);
    }
  });

  it.each(providers)("keeps %s defaults and aliases inside the built-in catalog", (provider) => {
    const slugs = new Set<string>(MODEL_OPTIONS_BY_PROVIDER[provider].map((model) => model.slug));
    for (const defaults of defaultMaps) {
      expect(slugs.has(defaults[provider])).toBe(true);
    }
    for (const target of Object.values(MODEL_SLUG_ALIASES_BY_PROVIDER[provider])) {
      expect(slugs.has(target)).toBe(true);
    }
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual([
      "ultra",
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  it("omits ultra from GPT-6 Astra while preserving the descending effort order", () => {
    expect(getReasoningEffortOptions("codex", "gpt-6-astra")).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
    expect(getReasoningEffortOptions("codex", "gpt-6-astra")).not.toContain("ultra");
  });

  it("keeps all Codex reasoning efforts for GPT-5.6 Sol", () => {
    expect(getReasoningEffortOptions("codex", "gpt-5.6-sol")).toEqual([
      "ultra",
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
    ]);
  });

  it("clamps unsupported Codex efforts toward the nearest weaker supported effort", () => {
    expect(resolveCodexReasoningEffortForModel("gpt-6-astra", "ultra")).toBe("max");
    expect(resolveCodexReasoningEffortForModel("gpt-6-astra", "garbage")).toBe("high");
  });

  it("keeps provider-wide efforts available for custom Codex models", () => {
    expect(resolveCodexReasoningEffortForModel("custom/internal-model", "ultra")).toBe("ultra");
  });

  it("exposes full Claude Fable effort controls", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });

  it("exposes the full Claude Opus 5 effort ladder", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });

  it("exposes full Claude Sonnet 5 effort controls", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-sonnet-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });

  it("keeps Opus 4.6 effort support without exposing xhigh", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("keeps Opus 4.5 effort support aligned with Opus 4.6", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-5")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("exposes full Claude Opus effort controls for Opus 4.7", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });

  it("exposes full Claude Opus effort controls for Opus 4.8", () => {
    expect(getReasoningEffortOptions("claudeAgent", "claude-opus-4-8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });
});

describe("Claude capability predicates", () => {
  it("enables Opus 5 effort and Fast Mode without context or thinking toggles", () => {
    expect(supportsClaudeFastMode("claude-opus-5")).toBe(true);
    expect(supportsClaudeContextWindow("claude-opus-5")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-opus-5")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-5")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-5")).toBe(true);
  });

  it("enables Sonnet 5 adaptive effort and context controls", () => {
    expect(supportsClaudeFastMode("claude-sonnet-5")).toBe(false);
    expect(supportsClaudeContextWindow("claude-sonnet-5")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-sonnet-5")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-sonnet-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-sonnet-5")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-sonnet-5")).toBe(true);
  });
  it("enables Claude Fable 5 effort capabilities while keeping fast mode and thinking off", () => {
    expect(supportsClaudeFastMode("claude-fable-5")).toBe(false);
    expect(supportsClaudeContextWindow("claude-fable-5")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-fable-5")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-fable-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-fable-5")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-fable-5")).toBe(true);
  });

  it("enables Claude Opus 4.7 effort capabilities while keeping fast mode off", () => {
    expect(supportsClaudeFastMode("claude-opus-4-7")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-opus-4-7")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-7")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-7")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-7")).toBe(true);
  });

  it("enables Claude Opus 4.8 effort capabilities and Fast Mode", () => {
    expect(supportsClaudeFastMode("claude-opus-4-8")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-opus-4-8")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-8")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-8")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-8")).toBe(true);
  });

  it("keeps Claude Opus 4.6 effort capabilities while disabling Fast Mode", () => {
    expect(supportsClaudeFastMode("claude-opus-4-6")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-6")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-6")).toBe(true);
  });

  it("keeps Claude Opus 4.5 effort capabilities while disabling Fast Mode", () => {
    expect(supportsClaudeFastMode("claude-opus-4-5")).toBe(false);
    expect(supportsClaudeContextWindow("claude-opus-4-5")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-opus-4-5")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-5")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-5")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-5")).toBe(true);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
  });

  it("uses model-aware Claude defaults", () => {
    expect(getDefaultReasoningEffort("claudeAgent", "claude-opus-5")).toBe("high");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-fable-5")).toBe("max");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-opus-4-8")).toBe("xhigh");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-opus-4-7")).toBe("xhigh");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-opus-4-6")).toBe("high");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-opus-4-5")).toBe("high");
    expect(getDefaultReasoningEffort("claudeAgent", "claude-sonnet-4-6")).toBe("high");
  });
});

describe("getEffectiveClaudeCodeEffort", () => {
  it("passes through explicit Claude session effort levels except ultrathink", () => {
    expect(getEffectiveClaudeCodeEffort("xhigh")).toBe("xhigh");
    expect(getEffectiveClaudeCodeEffort("max")).toBe("max");
    expect(getEffectiveClaudeCodeEffort("ultrathink")).toBeNull();
  });
});

describe("estimateModelContextWindowTokens", () => {
  it("returns the configured context windows for known models", () => {
    expect(estimateModelContextWindowTokens("gpt-6-astra")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.6-sol")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.6")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.5")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.4")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.4-mini")).toBe(400_000);
    expect(estimateModelContextWindowTokens("claude-fable-5")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-opus-5")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-opus-4-8")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-opus-4-7")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-opus-4-5")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("falls back to the default window for unknown or missing models", () => {
    expect(estimateModelContextWindowTokens("custom-model")).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    );
    expect(estimateModelContextWindowTokens(undefined)).toBe(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
  });

  it("respects the explicit provider when resolving aliases", () => {
    expect(estimateModelContextWindowTokens("gpt-5.3", "codex")).toBe(400_000);
    expect(estimateModelContextWindowTokens("opus", "claudeAgent")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("sonnet", "claudeAgent")).toBe(1_000_000);
    expect(estimateModelContextWindowTokens("claude-fable-5[1m]", "claudeAgent")).toBe(1_000_000);
  });
});

describe("Claude context window options", () => {
  it("normalizes supported Claude context-window values", () => {
    expect(normalizeClaudeContextWindow("200k")).toBe("200k");
    expect(normalizeClaudeContextWindow(" 1M ")).toBe("1m");
    expect(normalizeClaudeContextWindow("2m")).toBeUndefined();
  });

  it("maps Claude context windows to token windows", () => {
    expect(getClaudeContextWindowTokens("200k")).toBe(200_000);
    expect(getClaudeContextWindowTokens("1m")).toBe(1_000_000);
  });

  it("preserves explicit context windows when normalizing Claude options", () => {
    expect(
      normalizeClaudeModelOptions("claude-fable-5", {
        effort: "max",
        contextWindow: "200k",
      }),
    ).toEqual({ contextWindow: "200k" });
    expect(
      normalizeClaudeModelOptions("claude-fable-5", {
        contextWindow: "1m",
      }),
    ).toEqual({ contextWindow: "1m" });
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        contextWindow: "1m",
      }),
    ).toBeUndefined();
  });

  it("converts Claude model options to provider option selections", () => {
    expect(
      claudeModelOptionsToProviderOptionSelections({
        effort: "max",
        contextWindow: "1m",
      }),
    ).toEqual([
      { id: "effort", value: "max" },
      { id: "contextWindow", value: "1m" },
    ]);
    expect(
      claudeModelOptionsToProviderOptionSelections(
        {
          contextWindow: "1m",
        },
        "claude-haiku-4-5",
      ),
    ).toBeUndefined();
  });
});

describe("estimateMessageContextCharacters", () => {
  it("counts text, reasoning text, and attachment names", () => {
    expect(
      estimateMessageContextCharacters({
        text: "Hello",
        reasoningText: "thinking",
        attachmentNames: ["diagram.png", "notes.md"],
      }),
    ).toBe("Hello".length + "thinking".length + "diagram.png, notes.md".length);
  });
});

describe("estimateContextTokensAfterMessageUpdate", () => {
  it("seeds the estimate from a full character total when no snapshot exists", () => {
    expect(
      estimateContextTokensAfterMessageUpdate({
        previousEstimatedContextTokens: null,
        nextMessageCharacters: 12,
        fallbackTotalCharacters: 40,
      }),
    ).toBe(roughTokenEstimateFromCharacters(40));
  });

  it("applies signed deltas when incrementally updating an existing snapshot", () => {
    expect(
      estimateContextTokensAfterMessageUpdate({
        previousEstimatedContextTokens: 1_000,
        previousMessageCharacters: 20,
        nextMessageCharacters: 36,
      }),
    ).toBe(1_004);

    expect(
      estimateContextTokensAfterMessageUpdate({
        previousEstimatedContextTokens: 1_000,
        previousMessageCharacters: 36,
        nextMessageCharacters: 20,
      }),
    ).toBe(996);
  });
});
