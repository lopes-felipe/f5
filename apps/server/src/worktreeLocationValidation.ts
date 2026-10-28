import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { homedir } from "node:os";
import { canonicalWorktreePath } from "./git/worktreePaths.ts";
import { resolveWorktreesDirectory, customWorktreesDirectory } from "./worktreesDirectoryPaths.ts";
import { projectRoots } from "./profiles/RepositorySharing.ts";
import type { ServerConfigShape } from "./config.ts";

const contains = (parent: string, child: string) => {
  const relative = Path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !Path.isAbsolute(relative));
};

export async function validateWorktreeLocation(setting: string, config: ServerConfigShape) {
  if (!setting) return;
  const directory = resolveWorktreesDirectory(setting, config.worktreesDir);
  if (!directory)
    throw new Error("Worktree location must be an absolute folder, not a drive root.");
  const canonical = await canonicalWorktreePath(directory);
  if (
    Path.dirname(canonical) === canonical ||
    canonical === (await canonicalWorktreePath(homedir()))
  )
    throw new Error("Worktree location cannot be a drive root or your home folder.");
  for (const protectedPath of [
    config.baseDir,
    config.stateDir,
    ...(await projectRoots(config.stateDir)),
  ]) {
    const protectedRoot = await canonicalWorktreePath(protectedPath);
    if (contains(canonical, protectedRoot) || contains(protectedRoot, canonical))
      throw new Error("Worktree location must be separate from F5 app data and project checkouts.");
  }
}

/** Unavailable roots are retained. Only a reachable tree of empty directories is forgotten. */
export async function unusedWorktreeLocation(
  setting: string,
  defaultDir: string,
): Promise<boolean> {
  const directory = resolveWorktreesDirectory(setting, defaultDir);
  if (!directory) return false;
  let visited = 0;
  const empty = async (path: string, depth: number): Promise<boolean> => {
    if (++visited > 256) return false;
    const entries = await FS.readdir(path, { withFileTypes: true });
    if (depth === 0 && entries.length) return false;
    for (const entry of entries)
      if (!entry.isDirectory() || !(await empty(Path.join(path, entry.name), depth - 1)))
        return false;
    return true;
  };
  try {
    return await empty(customWorktreesDirectory(directory, defaultDir), 3);
  } catch {
    return false;
  }
}
