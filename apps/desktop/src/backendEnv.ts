import * as OS from "node:os";
import * as Path from "node:path";

import { USERDATA_STATE_DIR_NAME, defaultF5UserdataStateDir } from "@t3tools/shared/appStatePaths";

export interface DesktopBackendEnvOptions {
  readonly backendPort: number;
  readonly stateDir: string;
  readonly stateDirSource: DesktopStateDirSource;
  readonly authToken: string;
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
    return { stateDir: explicitStateDir, source: "explicit-state" };
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

  return {
    ...baseEnv,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(options.backendPort),
    ...stateDirEnv,
    T3CODE_AUTH_TOKEN: options.authToken,
    ...(baseEnv.T3CODE_OBSERVABILITY_ENABLED !== undefined
      ? {
          T3CODE_OBSERVABILITY_ENABLED: baseEnv.T3CODE_OBSERVABILITY_ENABLED,
        }
      : {}),
  };
}
