import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import * as NodePath from "node:path";

export interface WindowsRegistryPaths {
  readonly machine?: string;
  readonly user?: string;
}

export type WindowsRegistryPathReader = (
  environment: NodeJS.ProcessEnv,
) => Promise<WindowsRegistryPaths | undefined>;

export type WindowsPathExists = (path: string) => Promise<boolean>;

export interface HydrateWindowsPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly readRegistryPaths?: WindowsRegistryPathReader;
  readonly pathExists?: WindowsPathExists;
  readonly warn?: (message: string) => void;
}

let cachedRegistryPathsPromise: Promise<WindowsRegistryPaths | undefined> | undefined;
let processWindowsPathHydrationPromise: Promise<string | undefined> | undefined;

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

function installPath(environment: NodeJS.ProcessEnv, path: string): void {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") delete environment[key];
  }
  environment.PATH = path;
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

export const readWindowsRegistryPaths: WindowsRegistryPathReader = async (environment) => {
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
  const stdout = await new Promise<string | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    let output = "";
    let settled = false;
    const settle = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle(undefined);
    }, 3_000);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 64 * 1024) {
        child.kill();
        settle(undefined);
      }
    });
    child.once("error", () => settle(undefined));
    child.once("close", (code) => settle(code === 0 && output.trim() ? output : undefined));
  });
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return {
      ...(typeof parsed[0] === "string" ? { machine: parsed[0] } : {}),
      ...(typeof parsed[1] === "string" ? { user: parsed[1] } : {}),
    };
  } catch {
    return undefined;
  }
};

function cachedReadRegistryPaths(
  environment: NodeJS.ProcessEnv,
): Promise<WindowsRegistryPaths | undefined> {
  cachedRegistryPathsPromise ??= readWindowsRegistryPaths(environment);
  return cachedRegistryPathsPromise;
}

export function resetWindowsPathCache(): void {
  cachedRegistryPathsPromise = undefined;
  processWindowsPathHydrationPromise = undefined;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hydrateWindowsPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;

  const reader = options.readRegistryPaths ?? cachedReadRegistryPaths;
  const [registryPaths, knownDirectories] = await Promise.all([
    reader(environment).catch(() => undefined),
    Promise.all(
      knownWindowsInstallDirectories(environment).map(async (candidate) =>
        (await (options.pathExists ?? pathExists)(candidate).catch(() => false))
          ? candidate
          : undefined,
      ),
    ).then((entries) => entries.filter((entry): entry is string => entry !== undefined)),
  ]);
  if (!registryPaths) {
    options.warn?.("Unable to read the Windows registry PATH; using the inherited PATH.");
  }
  const merged = mergeWindowsPathValues([
    inheritedPath(environment),
    registryPaths?.machine,
    registryPaths?.user,
    ...knownDirectories,
  ]);

  installPath(environment, merged);
  return merged;
}

export function ensureWindowsPathHydrated(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return Promise.resolve(undefined);
  if (options.readRegistryPaths !== undefined || options.pathExists !== undefined) {
    return hydrateWindowsPath(environment, options);
  }
  processWindowsPathHydrationPromise ??= hydrateWindowsPath(process.env, options);
  if (environment === process.env) return processWindowsPathHydrationPromise;
  // A caller-supplied environment is an explicit execution boundary. Await
  // process hydration so startup remains serialized, but never widen or mutate
  // a deliberately restricted PATH with user-writable global install folders.
  return processWindowsPathHydrationPromise.then(() => inheritedPath(environment) || undefined);
}
