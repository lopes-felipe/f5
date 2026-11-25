import * as OS from "node:os";
import * as Path from "node:path";
import { canonicalDesktopStateDir } from "@t3tools/shared/desktopAppControl";

import { USERDATA_STATE_DIR_NAME, defaultF5UserdataStateDir } from "@t3tools/shared/appStatePaths";

export interface DesktopBackendEnvOptions {
  readonly profileSlug?: string;
  readonly backendPort: number;
  readonly stateDir: string;
  readonly stateDirSource: DesktopStateDirSource;
  readonly authToken: string;
  /** Whether syncShellEnvironment actually captured PATH into the base env. */
  readonly shellEnvironmentPrepared?: boolean;
}

export type DesktopStateDirSource = "explicit-state" | "home" | "default";

export interface DesktopStateDirResolution {
  readonly stateDir: string;
  readonly source: DesktopStateDirSource;
}

export function resolveDesktopStateDirConfig(
  env: NodeJS.ProcessEnv,
  homeDir?: string | undefined,
): DesktopStateDirResolution {
  const effectiveHomeDir = homeDir ?? OS.homedir();
  const resolveHomeStateDir = (raw: string | undefined): string | undefined => {
    const configured = raw?.trim();
    if (!configured) {
      return undefined;
    }
    const expanded =
      configured === "~"
        ? effectiveHomeDir
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? Path.join(effectiveHomeDir, configured.slice(2))
          : configured;
    return Path.resolve(expanded, USERDATA_STATE_DIR_NAME);
  };

  const explicitStateDir = env.F5_STATE_DIR?.trim() || env.T3CODE_STATE_DIR?.trim();
  if (explicitStateDir) {
    return { stateDir: canonicalDesktopStateDir(explicitStateDir), source: "explicit-state" };
  }

  const homeStateDir = resolveHomeStateDir(env.F5_HOME) || resolveHomeStateDir(env.T3CODE_HOME);
  if (homeStateDir) {
    return { stateDir: homeStateDir, source: "home" };
  }

  return { stateDir: defaultF5UserdataStateDir(homeDir), source: "default" };
}

export function resolveDesktopStateDir(
  env: NodeJS.ProcessEnv,
  homeDir?: string | undefined,
): string {
  return resolveDesktopStateDirConfig(env, homeDir).stateDir;
}

export function buildDesktopBackendEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: DesktopBackendEnvOptions,
): NodeJS.ProcessEnv {
  const stateDirEnv =
    options.stateDirSource === "explicit-state"
      ? {
          F5_STATE_DIR: options.stateDir,
          T3CODE_STATE_DIR: options.stateDir,
        }
      : {};
  // Strip inherited server/launcher variables so a parent shell's `F5_*` or
  // `T3CODE_*` values cannot hijack this desktop backend's port, host, mode, or token.
  const {
    F5_SHELL_ENVIRONMENT_PREPARED: _inheritedMarker,
    F5_MODE: _inheritedF5Mode,
    T3CODE_MODE: _inheritedT3Mode,
    F5_NO_BROWSER: _inheritedF5NoBrowser,
    T3CODE_NO_BROWSER: _inheritedT3NoBrowser,
    F5_PORT: _inheritedF5Port,
    T3CODE_PORT: _inheritedT3Port,
    F5_HOST: _inheritedF5Host,
    T3CODE_HOST: _inheritedT3Host,
    F5_AUTH_TOKEN: _inheritedF5AuthToken,
    T3CODE_AUTH_TOKEN: _inheritedT3AuthToken,
    ...inheritedEnv
  } = baseEnv;

  const observability =
    baseEnv.F5_OBSERVABILITY_ENABLED !== undefined
      ? { F5_OBSERVABILITY_ENABLED: baseEnv.F5_OBSERVABILITY_ENABLED }
      : baseEnv.T3CODE_OBSERVABILITY_ENABLED !== undefined
        ? { T3CODE_OBSERVABILITY_ENABLED: baseEnv.T3CODE_OBSERVABILITY_ENABLED }
        : {};

  return {
    ...inheritedEnv,
    F5_PROFILE: options.profileSlug ?? "default",
    F5_MODE: "desktop",
    F5_NO_BROWSER: "1",
    // The backend starts after syncShellEnvironment. When it captured the
    // login-shell or registry PATH, the server skips probing it again; after a
    // timed-out probe the server runs its own PATH repair.
    ...(options.shellEnvironmentPrepared ? { F5_SHELL_ENVIRONMENT_PREPARED: "1" } : {}),
    F5_PORT: String(options.backendPort),
    ...stateDirEnv,
    F5_AUTH_TOKEN: options.authToken,
    ...observability,
  };
}
