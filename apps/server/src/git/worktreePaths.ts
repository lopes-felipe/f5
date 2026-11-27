import { lstat, realpath } from "node:fs/promises";
import * as Path from "node:path";
import { defaultF5BaseDir } from "@t3tools/shared/appStatePaths";

export function resolveDefaultWorktreesDir(homeDir?: string): string {
  return Path.join(defaultF5BaseDir(homeDir), "worktrees");
}

/** Portable, bounded labels; hashes retain the exact repository/branch identity. */
export function worktreePathSlug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "wt"
  );
}

export function worktreePathExceedsWindowsLimit(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && value.length > 180;
}

/** Resolve symlinked ancestors even when a registered worktree directory is gone. */
export async function canonicalWorktreePath(value: string): Promise<string> {
  let ancestor = Path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return Path.join(await realpath(ancestor), ...missing.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = Path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(Path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * True for a folder that is there but is no checkout: its worktree was
 * deleted, and something (a dev server, a build cache) wrote the folder back.
 * A missing folder is not one, since its volume may only be unmounted.
 */
export async function isLeftoverWorktreeFolder(value: string): Promise<boolean> {
  const missing = (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  };
  if (await lstat(value).then(() => false, missing)) return false;
  return lstat(Path.join(value, ".git")).then(() => false, missing);
}

export { isTemporaryWorktreeBranch } from "@t3tools/shared/worktree";
