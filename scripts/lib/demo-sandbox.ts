// @effect-diagnostics nodeBuiltinImport:off
/**
 * Shared sandbox for demo and screenshot scripts.
 *
 * Every run gets a brand new root under the OS temp dir with its own `state/`
 * and `home/`. Roots are never reused or deleted, so a script can never wipe a
 * directory the caller pointed it at. Child processes get an allowlisted
 * environment: provider credentials, provider home overrides, forge tokens and
 * F5 profile variables from the parent shell never reach them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProtectedAppStateDir } from "@t3tools/shared/appStatePaths";

export function demoStateDir(root: string): string {
  return path.join(root, "state");
}

export function demoHomeDir(root: string): string {
  return path.join(root, "home");
}

export function createDemoRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const state = demoStateDir(root);
  fs.mkdirSync(state);
  fs.mkdirSync(demoHomeDir(root));
  if (isProtectedAppStateDir(state)) {
    throw new Error(`Refusing to use ${state}: it overlaps the real F5/T3 state directories.`);
  }
  return root;
}

// Non-secret variables a child needs to start processes. The Windows entries
// let child processes resolve executables, shells and a writable temp dir; the
// display entries let Electron reach the graphical session on Linux.
export const PASSTHROUGH_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
] as const;

export function isolatedEnv(
  root: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const state = demoStateDir(root);
  const home = demoHomeDir(root);
  return {
    ...env,
    // Windows resolves the home directory and provider config locations from
    // USERPROFILE/APPDATA/LOCALAPPDATA, falling back to the real profile when
    // they are absent, so all of them point into the sandbox too.
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    F5_STATE_DIR: state,
    T3CODE_STATE_DIR: state,
    T3CODE_OBSERVABILITY_ENABLED: "0",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
    T3CODE_NO_BROWSER: "1",
    ...extra,
  };
}

// Background usage sampling, provider update checks and turn resumption all
// reach out to provider CLIs or accounts; the demo never needs them.
export const DEMO_SERVER_SETTINGS = {
  usageBackgroundSampling: false,
  enableProviderUpdateChecks: false,
  resumeActiveTurnsAfterRestart: false,
} as const;

export function writeDemoSettings(root: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(demoStateDir(root), "settings.json");
  fs.writeFileSync(file, `${JSON.stringify({ ...DEMO_SERVER_SETTINGS, ...extra }, null, 2)}\n`);
  return file;
}
