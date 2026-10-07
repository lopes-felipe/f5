export const DEFAULT_CLAUDE_CLEANUP_PERIOD_DAYS = 3650;

/** Instance-native settings win over the server default; managed policy is applied by Claude. */
export function resolveClaudeCleanupPeriodDays(
  instanceSettings: unknown,
  environment: NodeJS.ProcessEnv,
): number {
  const instanceValue =
    instanceSettings && typeof instanceSettings === "object"
      ? (instanceSettings as Record<string, unknown>).cleanupPeriodDays
      : undefined;
  const configured =
    instanceValue !== undefined ? instanceValue : environment.F5_CLAUDE_CLEANUP_PERIOD_DAYS;
  const value =
    configured === undefined
      ? DEFAULT_CLAUDE_CLEANUP_PERIOD_DAYS
      : typeof configured === "string" && /^\d+$/.test(configured)
        ? Number(configured)
        : configured;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Claude cleanupPeriodDays must be an integer >= 1.");
  }
  return value;
}
