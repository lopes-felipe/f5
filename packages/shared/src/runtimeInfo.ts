import type { ProviderRuntimeInfo } from "@t3tools/contracts";
const text = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "boolean"
      ? value
        ? "enabled"
        : "disabled"
      : undefined;
/** Requests arrive as booleans while Claude and Cursor report `on`/`off`/`cooldown`. */
const fastModeText = (value: unknown): string | undefined =>
  value === true || value === "enabled"
    ? "on"
    : value === false || value === "disabled"
      ? "off"
      : text(value);
const FAST_MODE_DISABLED_REASONS: Record<string, string> = {
  free: "not available on the free plan",
  preference: "turned off in Claude settings",
  // The SDK still says "extra usage"; claude.ai now labels the setting "usage credits".
  extra_usage_disabled: "usage credits not enabled",
  network_error: "availability check failed",
  unknown: "unavailable for an unknown reason",
  not_first_party: "not available with this API provider",
  disabled_by_env: "disabled by environment",
  model_not_allowed: "not available for this model",
  sdk_opt_in_required: "SDK opt-in required",
  pending: "availability check pending",
};
/** Short phrase for the provider's reason fast mode can't serve; unknown reasons pass through. */
export function describeFastModeDisabledReason(reason: string): string {
  return FAST_MODE_DISABLED_REASONS[reason] ?? reason;
}
export interface FastModeDisabledReasonHelp {
  readonly text: string;
  readonly links: ReadonlyArray<{ readonly label: string; readonly url: string }>;
}
const FAST_MODE_REQUIREMENTS_LINK = {
  label: "Fast mode requirements",
  url: "https://code.claude.com/docs/en/fast-mode#requirements",
};
const FAST_MODE_DISABLED_REASON_HELP: Record<string, FastModeDisabledReasonHelp> = {
  extra_usage_disabled: {
    text:
      "Fast mode is billed to usage credits, which are off for this Claude account. On Pro and Max, " +
      "turn them on under Usage credits in Settings > Usage on claude.ai. On Team and Enterprise, " +
      "a member with billing access turns them on in Organization settings > Usage.",
    links: [
      { label: "Open Claude usage settings", url: "https://claude.ai/settings/usage" },
      FAST_MODE_REQUIREMENTS_LINK,
    ],
  },
  pending: {
    text: "Claude Code was still checking whether fast mode is available. This updates after the next turn.",
    links: [],
  },
  network_error: {
    text:
      "Claude Code could not reach api.anthropic.com to check fast mode availability, so turns run " +
      "at standard speed until a check succeeds. Proxies and LLM gateways can block this check.",
    links: [
      {
        label: "Fast mode behind proxies and gateways",
        url: "https://code.claude.com/docs/en/fast-mode#use-fast-mode-behind-proxies-and-llm-gateways",
      },
    ],
  },
  disabled_by_env: {
    text:
      "An environment variable such as CLAUDE_CODE_DISABLE_FAST_MODE turned fast mode off. Remove it " +
      "from the environment F5 starts Claude Code in, then start a new session.",
    links: [],
  },
};
/** What the user can do about a refused fast mode, with where to do it. */
export function fastModeDisabledReasonHelp(reason: string): FastModeDisabledReasonHelp {
  return (
    FAST_MODE_DISABLED_REASON_HELP[reason] ?? {
      text: "Claude Code reported that fast mode is not available. The requirements list what it needs.",
      links: [FAST_MODE_REQUIREMENTS_LINK],
    }
  );
}
/**
 * The provider's reason for refusing fast mode the user requested. Absent when fast mode was not
 * requested or is running, so a blocked but unrequested fast mode stays quiet. Accepts the
 * `enabled` vocabulary of activities stored before requests were normalized to `on`.
 */
export function refusedFastModeReason(
  runtime:
    | {
        readonly runtimeInfo?: ProviderRuntimeInfo | undefined;
        readonly fastModeState?: string | undefined;
        readonly fastModeDisabledReason?: string | undefined;
      }
    | null
    | undefined,
): string | undefined {
  const requested = fastModeText(runtime?.runtimeInfo?.requested.fastMode);
  const effective = fastModeText(
    runtime?.runtimeInfo?.effective.fastMode ?? runtime?.fastModeState,
  );
  return requested === "on" && effective !== "on" ? runtime?.fastModeDisabledReason : undefined;
}
/** Report only observed values; absent provider reports remain unknown. Costs and usage stay untouched. */
export function normalizeProviderRuntimeInfo(
  requested: Record<string, unknown>,
  reported: Record<string, unknown>,
): ProviderRuntimeInfo {
  const values = (source: Record<string, unknown>) => {
    const result: { model?: string; effort?: string; thinking?: string; fastMode?: string } = {};
    const pairs = {
      model: text(source.model),
      effort: text(source.effort ?? source.reasoning),
      thinking: text(
        source.thinkingState ??
          source.thinking_state ??
          source.alwaysThinkingEnabled ??
          (source.thinking && typeof source.thinking === "object"
            ? (source.thinking as { type?: unknown }).type
            : source.thinking),
      ),
      fastMode: fastModeText(
        source.fastModeState ??
          source.fast_mode_state ??
          source.fastMode ??
          (source.serviceTier === "fast"
            ? true
            : source.serviceTier === "default"
              ? false
              : undefined),
      ),
    };
    for (const key of ["model", "effort", "thinking", "fastMode"] as const) {
      const value = pairs[key];
      if (value !== undefined) result[key] = value;
    }
    return result;
  };
  const desired = values(requested);
  const effective = values(reported);
  const changed = (["model", "effort", "thinking", "fastMode"] as const).filter(
    (key) =>
      desired[key] !== undefined && effective[key] !== undefined && desired[key] !== effective[key],
  );
  const fastModeReason = text(
    reported.fast_mode_disabled_reason ?? reported.fastModeDisabledReason,
  );
  const describe = (key: (typeof changed)[number]) =>
    `${key}: ${desired[key]} → ${effective[key]}` +
    (key === "fastMode" && fastModeReason
      ? ` (${describeFastModeDisabledReason(fastModeReason)})`
      : "");
  return {
    requested: desired,
    effective,
    ...(changed.length ? { fallback: changed.map(describe).join("; ") } : {}),
  };
}
