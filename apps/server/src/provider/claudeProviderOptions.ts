import type { ClaudeThinkingOption, ProviderStartOptions } from "@t3tools/contracts";

export function toClaudeProviderStartOptions(input: {
  readonly binaryPath: string | undefined;
}): ProviderStartOptions | undefined {
  if (!input.binaryPath) {
    return undefined;
  }

  return {
    claudeAgent: {
      binaryPath: input.binaryPath,
    },
  };
}

/** The Agent SDK `ThinkingConfig` shape F5 sends. */
export type ClaudeThinkingConfig = ClaudeThinkingOption;

export type ClaudeThinkingSource = "toggle" | "typed" | "legacy" | "default";

export interface ClaudeThinkingResolution {
  /** Value for `Options.thinking`; omitted when native defaults apply. */
  readonly thinking?: ClaudeThinkingConfig;
  /**
   * Flag-settings value consistent with `thinking`. Only set when the per-turn
   * toggle is available, so it never contradicts the launch `thinking` option.
   */
  readonly alwaysThinkingEnabled?: boolean;
  /** Which input decided the outcome, for reporting the effective mode. */
  readonly source: ClaudeThinkingSource;
  /** Present when a requested shape was adapted to what the model supports. */
  readonly fallback?: string;
}

export class ClaudeThinkingConfigError extends Error {
  override readonly name = "ClaudeThinkingConfigError";
}

/**
 * Single thinking resolver for every Claude launch path (sessions, one-off
 * prompts and git text generation).
 *
 * Precedence: per-turn toggle, then typed `thinking`, then the deprecated
 * `maxThinkingTokens`, then native defaults. The toggle decides on/off; the
 * lower layers only refine the "on" shape.
 *
 * Legacy mapping: `0` → disabled; `>0` → adaptive on adaptive models, else
 * `{enabled, budgetTokens}`. With no input, toggle false → disabled;
 * otherwise `thinking` is omitted.
 *
 * `supportsAdaptive` is `undefined` for models F5 has no metadata for; explicit
 * configs are then passed through for the runtime to validate.
 */
export function claudeThinkingConfig(input: {
  readonly toggle?: boolean | undefined;
  readonly typed?: ClaudeThinkingOption | undefined;
  readonly legacyMaxThinkingTokens?: number | undefined;
  readonly supportsAdaptive?: boolean | undefined;
  readonly model?: string | undefined;
}): ClaudeThinkingResolution {
  const toggleSetting =
    typeof input.toggle === "boolean" ? { alwaysThinkingEnabled: input.toggle } : {};
  if (input.toggle === false) {
    return { thinking: { type: "disabled" }, ...toggleSetting, source: "toggle" };
  }

  const onShape = resolveOnShape(input);
  if (input.toggle === true) {
    // The toggle forces thinking on; a lower layer may only refine how.
    if (onShape && onShape.resolution.thinking?.type !== "disabled") {
      return { ...onShape.resolution, ...toggleSetting };
    }
    return { ...toggleSetting, source: "toggle" };
  }
  return onShape?.resolution ?? { source: "default" };
}

function resolveOnShape(input: {
  readonly typed?: ClaudeThinkingOption | undefined;
  readonly legacyMaxThinkingTokens?: number | undefined;
  readonly supportsAdaptive?: boolean | undefined;
  readonly model?: string | undefined;
}): { readonly resolution: ClaudeThinkingResolution } | undefined {
  if (input.typed) {
    if (input.typed.type === "adaptive" && input.supportsAdaptive === false) {
      throw new ClaudeThinkingConfigError(
        `Adaptive thinking is not supported by ${input.model ?? "this model"}. Use { type: "enabled", budgetTokens } or "disabled".`,
      );
    }
    return { resolution: { thinking: input.typed, source: "typed" } };
  }
  const legacy = input.legacyMaxThinkingTokens;
  if (legacy === undefined) return undefined;
  if (legacy === 0) return { resolution: { thinking: { type: "disabled" }, source: "legacy" } };
  if (input.supportsAdaptive === true) {
    return {
      resolution: {
        thinking: { type: "adaptive" },
        source: "legacy",
        fallback: `maxThinkingTokens ${legacy} runs as adaptive thinking; adaptive models ignore fixed budgets.`,
      },
    };
  }
  return {
    resolution: { thinking: { type: "enabled", budgetTokens: legacy }, source: "legacy" },
  };
}

/** CLI flags equivalent to the SDK's translation of `Options.thinking`. */
export function claudeThinkingCliArgs(thinking: ClaudeThinkingConfig | undefined): string[] {
  if (!thinking) return [];
  const args =
    thinking.type === "disabled"
      ? ["--thinking", "disabled"]
      : thinking.type === "enabled" && thinking.budgetTokens !== undefined
        ? ["--max-thinking-tokens", String(thinking.budgetTokens)]
        : ["--thinking", "adaptive"];
  if (thinking.type !== "disabled" && thinking.display) {
    args.push("--thinking-display", thinking.display);
  }
  return args;
}
