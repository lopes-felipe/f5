import type { ProviderRuntimeInfo } from "@t3tools/contracts";
const text = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "boolean"
      ? value
        ? "enabled"
        : "disabled"
      : undefined;
/** Report only observed values; absent provider reports remain unknown. Costs and usage stay untouched. */
export function normalizeProviderRuntimeInfo(
  requested: Record<string, unknown>,
  reported: Record<string, unknown>,
): ProviderRuntimeInfo {
  const values = (source: Record<string, unknown>) => {
    const result: { model?: string; effort?: string; thinking?: string; fastMode?: string } = {};
    const pairs = {
      model: source.model,
      effort: source.effort ?? source.reasoning,
      thinking:
        source.thinkingState ??
        source.thinking_state ??
        source.alwaysThinkingEnabled ??
        (source.thinking && typeof source.thinking === "object"
          ? (source.thinking as { type?: unknown }).type
          : source.thinking),
      fastMode:
        source.fastModeState ??
        source.fast_mode_state ??
        source.fastMode ??
        (source.serviceTier === "fast"
          ? true
          : source.serviceTier === "default"
            ? false
            : undefined),
    };
    for (const key of ["model", "effort", "thinking", "fastMode"] as const) {
      const value = text(pairs[key]);
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
  return {
    requested: desired,
    effective,
    ...(changed.length
      ? { fallback: changed.map((key) => `${key}: ${desired[key]} → ${effective[key]}`).join("; ") }
      : {}),
  };
}
