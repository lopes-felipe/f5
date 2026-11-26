/**
 * Shared boolean flag resolver for `F5_*` primary / `T3CODE_*` legacy timing
 * environment variables. When the primary variable is explicitly set (even to
 * `"0"` or `"false"`), it overrides the legacy alias.
 */
export function resolveAliasedBooleanEnv(
  primaryName: string,
  legacyName: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly raw: string | null; readonly enabled: boolean } {
  const primary = env[primaryName];
  const raw = primary !== undefined ? primary : (env[legacyName] ?? null);
  return {
    raw,
    enabled: raw === "1" || raw === "true",
  };
}

export const THREAD_OPEN_TIMINGS_ENV = {
  primary: "F5_LOG_THREAD_OPEN_TIMINGS",
  legacy: "T3CODE_LOG_THREAD_OPEN_TIMINGS",
} as const;

export const PROJECTION_TIMINGS_ENV = {
  primary: "F5_LOG_PROJECTION_TIMINGS",
  legacy: "T3CODE_LOG_PROJECTION_TIMINGS",
} as const;
