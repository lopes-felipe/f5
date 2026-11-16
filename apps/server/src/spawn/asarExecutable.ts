import { statSync } from "node:fs";

const ASAR_SEGMENT = /(^|[\\/])([^\\/]+\.asar)(?=[\\/])/;

export function isAsarExecutablePath(executable: string): boolean {
  return ASAR_SEGMENT.test(executable);
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Native processes cannot traverse Electron's virtual ASAR filesystem. Resolve
 * their on-disk sibling before passing a path to spawn or a shell wrapper.
 */
export function resolveAsarExecutablePath(
  executable: string,
  options: {
    readonly electron?: boolean;
    readonly fileExists?: (filePath: string) => boolean;
  } = {},
): string {
  if (!(options.electron ?? Boolean(process.versions.electron))) return executable;
  const unpacked = executable.replace(ASAR_SEGMENT, "$1$2.unpacked");
  return unpacked !== executable && (options.fileExists ?? isFile)(unpacked)
    ? unpacked
    : executable;
}
