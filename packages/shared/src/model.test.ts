import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";

import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  estimateContextTokensAfterMessageUpdate,
  estimateModelContextWindowTokens,
  estimateMessageContextCharacters,
  getDefaultModel,
  getEffectiveClaudeCodeEffort,
  getDefaultReasoningEffort,
  getModelOptions,
  getReasoningEffortOptions,
  normalizeModelSlug,
  roughTokenEstimateFromCharacters,
  resolveModelSlug,
  supportsClaudeAdaptiveReasoning,
  supportsClaudeFastMode,
  supportsClaudeMaxEffort,
  supportsClaudeThinkingToggle,
  supportsClaudeUltrathinkKeyword,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.5")).toBe("gpt-5.5");
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("opus", "claudeAgent")).toBe("claude-opus-4-6");
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

  it("keeps Claude Sonnet 4.6 as the Claude default while exposing Opus 4.7", () => {
    expect(getDefaultModel("claudeAgent")).toBe(DEFAULT_MODEL_BY_PROVIDER.claudeAgent);
    expect(DEFAULT_MODEL_BY_PROVIDER.claudeAgent).toBe("claude-sonnet-4-6");
    expect(getModelOptions("claudeAgent").map((option) => option.slug)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
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
});

describe("Claude capability predicates", () => {
  it("enables Claude Opus 4.7 effort capabilities while keeping fast mode off", () => {
    expect(supportsClaudeFastMode("claude-opus-4-7")).toBe(false);
    expect(supportsClaudeMaxEffort("claude-opus-4-7")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-7")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-7")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-7")).toBe(true);
  });

  it("retains documented Claude Opus 4.6 capabilities", () => {
    expect(supportsClaudeFastMode("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeMaxEffort("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeAdaptiveReasoning("claude-opus-4-6")).toBe(true);
    expect(supportsClaudeThinkingToggle("claude-opus-4-6")).toBe(false);
    expect(supportsClaudeUltrathinkKeyword("claude-opus-4-6")).toBe(true);
  });

  it("retains documented Claude Opus 4.5 capabilities", () => {
    expect(supportsClaudeFastMode("claude-opus-4-5")).toBe(true);
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
    expect(estimateModelContextWindowTokens("gpt-5.5")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.4")).toBe(1_050_000);
    expect(estimateModelContextWindowTokens("gpt-5.4-mini")).toBe(400_000);
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
