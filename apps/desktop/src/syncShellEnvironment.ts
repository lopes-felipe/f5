import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";
import {
  ensureWindowsPathHydrated,
  type WindowsRegistryPathReader,
} from "@t3tools/shared/windowsPath";

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
  if (platform !== "darwin") return Promise.resolve();

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "SSH_AUTH_SOCK",
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
  return Promise.resolve();
}
