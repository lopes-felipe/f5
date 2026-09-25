import * as FS from "node:fs";
import * as Path from "node:path";

interface GhBinaryFs {
  accessSync(path: string, mode?: number): void;
  statSync(path: string): { isFile(): boolean };
  constants: { F_OK: number; X_OK: number };
}
interface GhBinaryPath {
  delimiter: string;
  join(...parts: string[]): string;
  resolve(path: string): string;
}

/**
 * Finds the real GitHub CLI on PATH, skipping F5's own launcher directory.
 * Self-contained (no closures or imports) because the generated launcher script embeds its
 * source via `Function.prototype.toString`, keeping one implementation for both callers.
 */
export function findGhBinary(
  pathValue: string,
  ownDirectory: string,
  platform: string,
  fs: GhBinaryFs,
  path: GhBinaryPath,
): { paths: string[]; binary: string | undefined } {
  const own = path.resolve(ownDirectory).toLowerCase();
  const isLauncherDirectory = (entry: string) => {
    if (path.resolve(entry).toLowerCase() === own) return true;
    // Any F5 launcher (another profile, or an F5 started from an F5 terminal) would redirect
    // gh to a different profile's credentials.
    try {
      fs.accessSync(path.join(entry, "gh.cjs"), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  const paths = pathValue
    .split(path.delimiter)
    .filter((entry) => entry && !isLauncherDirectory(entry));
  const name = platform === "win32" ? "gh.exe" : "gh";
  const binary = paths
    .map((entry) => path.join(entry, name))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  return { paths, binary };
}

export function pathFromEnvironment(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return (key ? env[key] : undefined) ?? "";
}

export function resolveGhBinary(env: NodeJS.ProcessEnv, launcherDir: string): string | undefined {
  return findGhBinary(pathFromEnvironment(env), launcherDir, process.platform, FS, Path).binary;
}
