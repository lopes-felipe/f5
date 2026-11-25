import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Checks a canonical workspace path before starting a recursive index. */
export async function getWorkspaceSearchRootRestriction(
  rootPath: string,
): Promise<string | undefined> {
  if (path.dirname(rootPath) === rootPath) {
    return "Workspace search is unavailable at the filesystem root.";
  }

  const home = os.homedir();
  const realHome = await fs.realpath(home).catch(() => home);
  if (path.relative(realHome, rootPath) !== "") {
    // realpath can preserve the caller's casing even on a case-insensitive volume.
    if (rootPath.toLowerCase() !== realHome.toLowerCase()) return undefined;
    const [workspaceStat, homeStat] = await Promise.all([
      fs.stat(rootPath, { bigint: true }),
      fs.stat(realHome, { bigint: true }).catch(() => null),
    ]);
    if (!homeStat || workspaceStat.dev !== homeStat.dev || workspaceStat.ino !== homeStat.ino) {
      return undefined;
    }
  }
  return "Workspace search is unavailable in the home directory.";
}
