import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";
import {
  ensureWindowsPathHydrated,
  type WindowsRegistryPathReader,
} from "@t3tools/shared/windowsPath";

const CA_TRUST_NAMES = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

const LOCALE_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

const APPIMAGE_SEARCH_PATH_ENV_NAMES = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"] as const;

// The AppImage runtime mounts each launch at `$TMPDIR/.mount_<id>` and prepends
// it to the search paths above. A launch started from a shell that inherited an
// earlier launch's env carries that mount too, and once it is unmounted every
// spawn that walks PATH (git first of all) fails with ENOTCONN.
const APPIMAGE_MOUNT_ROOT = /^(.*?\/\.mount_[^/]+)(?:\/|$)/u;

function stripStaleAppImageMounts(env: NodeJS.ProcessEnv): void {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return;
  const appDir = env.APPDIR?.replace(/\/+$/u, "");
  for (const name of APPIMAGE_SEARCH_PATH_ENV_NAMES) {
    const value = env[name];
    if (value === undefined) continue;
    // glibc's loader also splits LD_LIBRARY_PATH on `;`.
    const segments = value.split(name === "LD_LIBRARY_PATH" ? /[:;]/u : ":");
    const kept = segments.filter((segment) => {
      const mountRoot = APPIMAGE_MOUNT_ROOT.exec(segment)?.[1];
      return mountRoot === undefined || mountRoot === appDir;
    });
    if (kept.length === segments.length) continue;
    if (kept.length === 0) {
      delete env[name];
    } else {
      // An empty segment is the current dir to the loader and to PATH lookup,
      // but a lone one joins to "", which reads as unset.
      env[name] = kept.join(":") || ":";
    }
  }
}

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readWindowsRegistryPaths?: WindowsRegistryPathReader;
    windowsPathExists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return ensureWindowsPathHydrated(env, {
      platform,
      ...(options.readWindowsRegistryPaths
        ? { readRegistryPaths: options.readWindowsRegistryPaths }
        : {}),
      ...(options.windowsPathExists ? { pathExists: options.windowsPathExists } : {}),
      warn: options.warn ?? ((message) => console.warn(`[environment] ${message}`)),
    }).then(() => undefined);
  }
  // The backend, relaunch and updater all inherit process.env, so scrubbing
  // here keeps earlier AppImage launches' mounts out of every one of them.
  if (platform === "linux") stripStaleAppImageMounts(env);
  if (platform !== "darwin") return Promise.resolve();

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "__MISE_DIFF",
      "SSH_AUTH_SOCK",
      ...LOCALE_NAMES,
      ...CA_TRUST_NAMES,
    ]);

    for (const name of CA_TRUST_NAMES)
      if (!env[name]?.trim() && shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];

    // Locale categories form a precedence group; never override an inherited choice.
    if (LOCALE_NAMES.every((name) => !env[name]?.trim())) {
      for (const name of LOCALE_NAMES) {
        if (shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];
      }
    }

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
      // mise's record of the PATH entries it added. It must travel with the
      // shell's PATH, or `mise x` can rebuild PATH behind a same-named wrapper
      // (`exec mise x claude -- claude`) that then re-runs itself forever.
      if (shellEnvironment.__MISE_DIFF) env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
  if (LOCALE_NAMES.every((name) => !env[name]?.trim())) env.LC_CTYPE = "en_US.UTF-8";
  return Promise.resolve();
}
