import {
  applyLoginShellPath,
  LOGIN_SHELL_PATH_ENV_NAMES,
  readEnvironmentFromLoginShellAsync,
  type ShellEnvironmentReader,
} from "@t3tools/shared/shell";
import {
  applySavedWindowsDoNotTrack,
  ensureWindowsPathHydration,
  type WindowsRegistryPathReader,
} from "@t3tools/shared/windowsPath";

const CA_TRUST_NAMES = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

const LOCALE_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * Resolves true only when the backend can skip its own probe: the Windows
 * registry PATH was read, or the macOS login shell returned a PATH. A failed or
 * timed-out probe (cold boot, first launch after an update, endpoint scanning)
 * leaves the server to repair PATH.
 */
export async function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readWindowsRegistryPaths?: WindowsRegistryPathReader;
    windowsPathExists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
  } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const result = await ensureWindowsPathHydration(env, {
      platform,
      ...(options.readWindowsRegistryPaths
        ? { readRegistryPaths: options.readWindowsRegistryPaths }
        : {}),
      ...(options.windowsPathExists ? { pathExists: options.windowsPathExists } : {}),
      warn: options.warn ?? ((message) => console.warn(`[environment] ${message}`)),
    });
    applySavedWindowsDoNotTrack(env, result.savedDoNotTrack);
    return result.registryRead;
  }
  if (platform !== "darwin") return Promise.resolve(false);

  let prepared = false;
  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const inheritedMultishell = env.FNM_MULTISHELL_PATH;
    const shellEnvironment = await (options.readEnvironment ?? readEnvironmentFromLoginShellAsync)(
      shell,
      [
        ...LOGIN_SHELL_PATH_ENV_NAMES,
        "SSH_AUTH_SOCK",
        ...LOCALE_NAMES,
        ...CA_TRUST_NAMES,
        "DO_NOT_TRACK",
      ],
    );

    // An app launched from Finder misses an opt-out exported from the shell profile.
    if (!env.DO_NOT_TRACK?.trim() && shellEnvironment.DO_NOT_TRACK?.trim())
      env.DO_NOT_TRACK = shellEnvironment.DO_NOT_TRACK;

    for (const name of CA_TRUST_NAMES)
      if (!env[name]?.trim() && shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];

    // Locale categories form a precedence group; never override an inherited choice.
    if (LOCALE_NAMES.every((name) => !env[name]?.trim())) {
      for (const name of LOCALE_NAMES) {
        if (shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];
      }
    }

    prepared = applyLoginShellPath(env, shellEnvironment, inheritedMultishell);

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
  if (LOCALE_NAMES.every((name) => !env[name]?.trim())) env.LC_CTYPE = "en_US.UTF-8";
  return Promise.resolve(prepared);
}
