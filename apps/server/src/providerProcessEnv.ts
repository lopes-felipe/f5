const BLOCKED_PROVIDER_ENV_PREFIXES = ["OTEL_"] as const;

function isBlockedProviderEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return BLOCKED_PROVIDER_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix));
}

/**
 * Provider subprocesses should not inherit workstation-level OpenTelemetry
 * configuration. On managed machines that can redirect Codex / Claude logs and
 * traces to unrelated endpoints, producing noisy export errors and leaking
 * telemetry intended only for the parent shell or desktop app.
 */
export function buildProviderChildProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (isBlockedProviderEnvKey(key)) {
      continue;
    }
    env[key] = value;
  }

  if (!overrides) {
    return env;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}
