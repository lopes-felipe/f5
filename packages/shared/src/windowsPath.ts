import { Effect, Option } from "effect";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import * as NodePath from "node:path";

export interface WindowsRegistryPaths {
  readonly machine?: string;
  readonly user?: string;
  readonly savedDoNotTrack?: string;
}

export type WindowsRegistryPathReader = (
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<WindowsRegistryPaths | undefined>;

export type WindowsPathExists = (path: string) => Promise<boolean>;

export interface HydrateWindowsPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly readRegistryPaths?: WindowsRegistryPathReader;
  readonly pathExists?: WindowsPathExists;
  readonly warn?: (message: string) => void;
  readonly signal?: AbortSignal;
}

let cachedRegistryPaths: WindowsRegistryPaths | undefined;
let processHydration:
  | {
      readonly controller: AbortController;
      readonly promise: Promise<WindowsPathHydration>;
      waiters: number;
      settled: boolean;
    }
  | undefined;

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
  const trimmed = entry.trim().replaceAll('"', "");
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

const readPowerShellOutput = (command: string, script: string) =>
  Effect.callback<string | undefined>((resume) => {
    let child;
    try {
      child = execFile(
        command,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => resume(Effect.succeed(error ? undefined : stdout)),
      );
    } catch {
      return resume(Effect.succeed(undefined));
    }

    return Effect.sync(() => {
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  });

/** Read PATH and the saved privacy setting in one probe. Startup callers apply the setting after hydration. */
export const readWindowsRegistryPaths: WindowsRegistryPathReader = async (environment, signal) => {
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
    "$userDoNotTrack = [Environment]::GetEnvironmentVariable('DO_NOT_TRACK', 'User')",
    "$machineDoNotTrack = [Environment]::GetEnvironmentVariable('DO_NOT_TRACK', 'Machine')",
    "[Console]::Write((ConvertTo-Json @($machine, $user, $userDoNotTrack, $machineDoNotTrack) -Compress))",
  ].join("; ");
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      for (const shell of [powershell, "pwsh.exe"]) {
        const stdout = yield* readPowerShellOutput(shell, script);
        if (stdout?.trim()) return stdout;
      }
      return undefined;
    }).pipe(Effect.timeoutOption("3 seconds")),
    signal ? { signal } : undefined,
  );
  const stdout = Option.getOrUndefined(output);
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const savedDoNotTrack = [parsed[2], parsed[3]].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    return {
      ...(typeof parsed[0] === "string" ? { machine: parsed[0] } : {}),
      ...(typeof parsed[1] === "string" ? { user: parsed[1] } : {}),
      ...(savedDoNotTrack !== undefined ? { savedDoNotTrack } : {}),
    };
  } catch {
    return undefined;
  }
};

async function cachedReadRegistryPaths(
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<WindowsRegistryPaths | undefined> {
  if (cachedRegistryPaths) return cachedRegistryPaths;
  const paths = await readWindowsRegistryPaths(environment, signal);
  signal?.throwIfAborted();
  if (paths) cachedRegistryPaths = paths;
  return paths;
}

export function resetWindowsPathCache(): void {
  cachedRegistryPaths = undefined;
  processHydration = undefined;
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

export interface WindowsPathHydration {
  readonly path: string | undefined;
  /** False when the registry PATH could not be read and only inherited entries were kept. */
  readonly registryRead: boolean;
  /** The opt-out setting saved in the User or Machine registry scope. */
  readonly savedDoNotTrack?: string;
}

export function applySavedWindowsDoNotTrack(
  environment: NodeJS.ProcessEnv,
  savedDoNotTrack: string | undefined,
): void {
  if (
    savedDoNotTrack?.trim() &&
    !Object.entries(environment).some(
      ([key, value]) => key.toUpperCase() === "DO_NOT_TRACK" && value?.trim(),
    )
  ) {
    environment.DO_NOT_TRACK = savedDoNotTrack;
  }
}

export async function hydrateWindowsPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): Promise<string | undefined> {
  return (await hydrateWindowsPathWithStatus(environment, options)).path;
}

async function hydrateWindowsPathWithStatus(
  environment: NodeJS.ProcessEnv,
  options: HydrateWindowsPathOptions,
): Promise<WindowsPathHydration> {
  if ((options.platform ?? process.platform) !== "win32") {
    return { path: undefined, registryRead: false };
  }

  const { signal } = options;
  signal?.throwIfAborted();
  const reader = options.readRegistryPaths ?? cachedReadRegistryPaths;
  const [registryPaths, knownDirectories] = await Promise.all([
    reader(environment, signal).catch(() => undefined),
    Promise.all(
      knownWindowsInstallDirectories(environment).map(async (candidate) =>
        (await (options.pathExists ?? pathExists)(candidate).catch(() => false))
          ? candidate
          : undefined,
      ),
    ).then((entries) => entries.filter((entry): entry is string => entry !== undefined)),
  ]);
  signal?.throwIfAborted();
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
  const savedDoNotTrack = registryPaths?.savedDoNotTrack;
  return {
    path: merged,
    registryRead: registryPaths !== undefined,
    ...(savedDoNotTrack !== undefined ? { savedDoNotTrack } : {}),
  };
}

export function ensureWindowsPathHydrated(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): Promise<string | undefined> {
  return ensureWindowsPathHydration(environment, options).then((result) => result.path);
}

/** Like ensureWindowsPathHydrated, but also reports whether the registry PATH was read. */
export async function ensureWindowsPathHydration(
  environment: NodeJS.ProcessEnv = process.env,
  options: HydrateWindowsPathOptions = {},
): Promise<WindowsPathHydration> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { path: undefined, registryRead: false };
  const { signal } = options;
  signal?.throwIfAborted();
  if (options.readRegistryPaths !== undefined || options.pathExists !== undefined) {
    return hydrateWindowsPathWithStatus(environment, options);
  }

  if (!processHydration) {
    const controller = new AbortController();
    const hydration = {
      controller,
      waiters: 0,
      settled: false,
      promise: hydrateWindowsPathWithStatus(process.env, {
        ...options,
        signal: controller.signal,
      }).finally(() => {
        hydration.settled = true;
      }),
    };
    processHydration = hydration;
  }

  const hydration = processHydration;
  hydration.waiters += 1;
  let onAbort: (() => void) | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    hydration.waiters -= 1;
    // A startup cancellation stops the probe when nobody else is using it.
    if (hydration.waiters === 0 && !hydration.settled) {
      if (processHydration === hydration) processHydration = undefined;
      hydration.controller.abort();
    }
  };
  let result: WindowsPathHydration;
  try {
    result = await (signal
      ? new Promise<WindowsPathHydration>((resolve, reject) => {
          onAbort = () => {
            release();
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          void hydration.promise.then(resolve, reject);
        })
      : hydration.promise);
  } finally {
    release();
  }
  if (environment === process.env) return result;
  // A caller-supplied environment is an explicit execution boundary. Await
  // process hydration so startup remains serialized, but never widen or mutate
  // a deliberately restricted PATH with user-writable global install folders.
  return {
    path: inheritedPath(environment) || undefined,
    registryRead: result.registryRead,
  };
}
