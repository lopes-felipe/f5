import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as NodePath from "node:path";

export interface WindowsRegistryPaths {
  readonly machine?: string;
  readonly user?: string;
}

export type WindowsRegistryPathReader = (
  environment: NodeJS.ProcessEnv,
) => WindowsRegistryPaths | undefined;

export interface HydrateWindowsPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly readRegistryPaths?: WindowsRegistryPathReader;
  readonly pathExists?: (path: string) => boolean;
  readonly warn?: (message: string) => void;
}

let cachedRegistryPaths: WindowsRegistryPaths | undefined;
let didReadRegistryPaths = false;

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function inheritedPath(environment: NodeJS.ProcessEnv): string {
  return environmentValue(environment, "PATH") ?? "";
}

function normalizeEntry(entry: string): string {
  const trimmed = entry.trim().replace(/^"|"$/g, "");
  const root = NodePath.win32.parse(trimmed).root;
  return trimmed.length > root.length ? trimmed.replace(/[\\/]+$/u, "") : trimmed;
}

export function mergeWindowsPathValues(values: ReadonlyArray<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of values) {
    for (const rawEntry of value?.split(";") ?? []) {
      const entry = normalizeEntry(rawEntry);
      if (!entry) continue;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged.join(";");
}

export const readWindowsRegistryPaths: WindowsRegistryPathReader = (environment) => {
  const systemRoot =
    environmentValue(environment, "SystemRoot") ??
    environmentValue(environment, "SYSTEMROOT") ??
    "C:\\Windows";
  const powershell = NodePath.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$user = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "if ($machine) { $machine = [Environment]::ExpandEnvironmentVariables($machine) }",
    "if ($user) { $user = [Environment]::ExpandEnvironmentVariables($user) }",
    "[Console]::Write((ConvertTo-Json @($machine, $user) -Compress))",
  ].join("; ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return {
      ...(typeof parsed[0] === "string" ? { machine: parsed[0] } : {}),
      ...(typeof parsed[1] === "string" ? { user: parsed[1] } : {}),
    };
  } catch {
    return undefined;
  }
};

function cachedReadRegistryPaths(environment: NodeJS.ProcessEnv): WindowsRegistryPaths | undefined {
  if (!didReadRegistryPaths) {
    didReadRegistryPaths = true;
    cachedRegistryPaths = readWindowsRegistryPaths(environment);
  }
  return cachedRegistryPaths;
}

export function resetWindowsPathCache(): void {
  didReadRegistryPaths = false;
  cachedRegistryPaths = undefined;
}

function knownWindowsInstallDirectories(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = environmentValue(environment, "APPDATA");
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  const userProfile = environmentValue(environment, "USERPROFILE");
  const programFiles = environmentValue(environment, "ProgramFiles");
  const pnpmHome = environmentValue(environment, "PNPM_HOME");
  const bunInstall = environmentValue(environment, "BUN_INSTALL");
  const voltaHome = environmentValue(environment, "VOLTA_HOME");
  const nvmHome = environmentValue(environment, "NVM_HOME");
  const nvmSymlink = environmentValue(environment, "NVM_SYMLINK");
  const fnmDir = environmentValue(environment, "FNM_DIR");
  return [
    appData ? NodePath.win32.join(appData, "npm") : undefined,
    pnpmHome,
    bunInstall ? NodePath.win32.join(bunInstall, "bin") : undefined,
    programFiles ? NodePath.win32.join(programFiles, "nodejs") : undefined,
    voltaHome ? NodePath.win32.join(voltaHome, "bin") : undefined,
    userProfile ? NodePath.win32.join(userProfile, ".volta", "bin") : undefined,
    userProfile ? NodePath.win32.join(userProfile, ".local", "bin") : undefined,
    userProfile ? NodePath.win32.join(userProfile, "scoop", "shims") : undefined,
    fnmDir,
    localAppData ? NodePath.win32.join(localAppData, "fnm") : undefined,
    nvmHome,
    nvmSymlink,
  ].filter((entry): entry is string => Boolean(entry));
}

export function hydrateWindowsPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;

  const reader = options.readRegistryPaths ?? cachedReadRegistryPaths;
  const registryPaths = reader(environment);
  if (!registryPaths) {
    options.warn?.("Unable to read the Windows registry PATH; using the inherited PATH.");
  }
  const pathExists = options.pathExists ?? existsSync;
  const knownDirectories = knownWindowsInstallDirectories(environment).filter(pathExists);
  const merged = mergeWindowsPathValues([
    inheritedPath(environment),
    registryPaths?.machine,
    registryPaths?.user,
    ...knownDirectories,
  ]);

  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = merged;
  return merged;
}
