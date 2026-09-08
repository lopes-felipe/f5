import * as Path from "node:path";
import type { ActiveProfile, ProviderInstanceEnvironment } from "@t3tools/contracts";
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
  baseEnv: NodeJS.ProcessEnv,
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
    if (isBlockedProviderEnvKey(key)) continue;
    if (process.platform === "win32") {
      for (const inherited of Object.keys(env))
        if (inherited.toUpperCase() === key.toUpperCase()) delete env[inherited];
    }
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}

export const PROFILE_ISOLATED_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
] as const;
const reservedEnvironment =
  /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|XDG_.*|CODEX_HOME|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|F5_.*|T3CODE_.*)$/i;
export function assertAccountEnvironmentOverrides(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment))
    if (reservedEnvironment.test(key))
      throw new Error(
        `Environment variable ${key} is reserved for account isolation. Configure the provider home using its settings field.`,
      );
}
export function buildAccountExecutionEnvironment(input: {
  purpose: "provider" | "terminal" | "git" | "account";
  profile: ActiveProfile | undefined;
  stateDir: string;
  baseEnv: NodeJS.ProcessEnv;
  instance?: ProviderInstanceEnvironment | undefined;
  overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const isolated = input.profile !== undefined && !input.profile.isDefault;
  const base = { ...input.baseEnv };
  for (const key of Object.keys(base))
    if (key.toUpperCase() === "F5_PROFILE_ISOLATED") delete base[key];
  if (isolated) {
    for (const key of Object.keys(base)) {
      const normalized = key.toUpperCase();
      if (
        PROFILE_ISOLATED_CREDENTIAL_ENV_NAMES.some((name) => name === normalized) ||
        reservedEnvironment.test(key) ||
        /^(GIT_AUTHOR_|GIT_COMMITTER_)/i.test(key)
      )
        delete base[key];
    }
  }
  const instance = Object.fromEntries(
    (input.instance ?? []).map((variable) => [variable.name, variable.value]),
  );
  assertAccountEnvironmentOverrides(instance);
  if (input.overrides) assertAccountEnvironmentOverrides(input.overrides);
  const environment = buildProviderChildProcessEnv(base, { ...instance, ...input.overrides });
  if (!isolated) return environment;
  const home = Path.join(input.stateDir, "provider-homes", "claude");
  const drive = /^[a-z]:/i.exec(home)?.[0];
  return {
    ...environment,
    F5_PROFILE_ISOLATED: "1",
    HOME: home,
    USERPROFILE: home,
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: home.slice(2) } : {}),
    APPDATA: Path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: Path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: Path.join(home, ".config"),
    XDG_DATA_HOME: Path.join(home, ".local", "share"),
    XDG_CACHE_HOME: Path.join(home, ".cache"),
    CODEX_HOME: Path.join(input.stateDir, "provider-homes", "codex"),
    CLAUDE_CONFIG_DIR: Path.join(home, ".claude"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: Path.join(home, ".claude"),
    GH_CONFIG_DIR: Path.join(input.stateDir, "github"),
    ...(input.purpose === "git"
      ? {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: Path.join(input.stateDir, "gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
        }
      : {}),
  };
}
