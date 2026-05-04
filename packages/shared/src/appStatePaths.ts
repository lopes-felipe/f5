import * as OS from "node:os";
import * as Path from "node:path";

export const F5_HOME_DIR_NAME = ".f5";
export const LEGACY_T3_HOME_DIR_NAME = ".t3";
export const USERDATA_STATE_DIR_NAME = "userdata";
export const DEV_STATE_DIR_NAME = "dev";
export const STATE_DB_FILE_NAME = "state.sqlite";

export function defaultF5BaseDir(homeDir = OS.homedir()): string {
  return Path.join(homeDir, F5_HOME_DIR_NAME);
}

export function defaultF5UserdataStateDir(homeDir = OS.homedir()): string {
  return Path.join(defaultF5BaseDir(homeDir), USERDATA_STATE_DIR_NAME);
}

export function defaultF5DevStateDir(homeDir = OS.homedir()): string {
  return Path.join(defaultF5BaseDir(homeDir), DEV_STATE_DIR_NAME);
}

export function legacyT3BaseDir(homeDir = OS.homedir()): string {
  return Path.join(homeDir, LEGACY_T3_HOME_DIR_NAME);
}

export function legacyT3UserdataStateDir(homeDir = OS.homedir()): string {
  return Path.join(legacyT3BaseDir(homeDir), USERDATA_STATE_DIR_NAME);
}

export function legacyT3DevStateDir(homeDir = OS.homedir()): string {
  return Path.join(legacyT3BaseDir(homeDir), DEV_STATE_DIR_NAME);
}

export function isProtectedAppStateDir(value: string, homeDir = OS.homedir()): boolean {
  const expanded =
    value === "~"
      ? homeDir
      : value.startsWith("~/") || value.startsWith("~\\")
        ? Path.join(homeDir, value.slice(2))
        : value;
  const normalized = Path.resolve(expanded);
  const protectedBases = [defaultF5BaseDir(homeDir), legacyT3BaseDir(homeDir)].map((base) =>
    Path.resolve(base),
  );

  return protectedBases.some(
    (base) => normalized === base || normalized.startsWith(base + Path.sep),
  );
}
