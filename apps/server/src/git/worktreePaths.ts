import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
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

/**
 * Drops the registration of one leftover folder (see above) and nothing else.
 *
 * `git worktree remove --force` would delete the folder, and
 * `git worktree prune` drops every registration it can. This removes the one
 * administrative entry that points at `worktreePath`, after checking again
 * that the folder is still no checkout and that the entry is not locked.
 * Resolves to whether an entry was removed. The caller holds the repository lock.
 */
export async function dropLeftoverWorktreeRegistration(
  commonDir: string,
  worktreePath: string,
): Promise<boolean> {
  if (!(await isLeftoverWorktreeFolder(worktreePath))) return false;
  const target = await canonicalWorktreePath(worktreePath);
  const registrations = Path.join(commonDir, "worktrees");
  const ids = await readdir(registrations).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const id of ids) {
    const entry = Path.join(registrations, id);
    // `gitdir` names the checkout's `.git` file, relative to the entry when
    // the repository uses relative worktree paths.
    const link = await readFile(Path.join(entry, "gitdir"), "utf8").catch(() => null);
    if (link === null) continue;
    const checkout = Path.dirname(Path.resolve(entry, link.trim()));
    if ((await canonicalWorktreePath(checkout)) !== target) continue;
    if (
      await lstat(Path.join(entry, "locked")).then(
        () => true,
        () => false,
      )
    )
      return false;
    await rm(entry, { recursive: true, force: true });
    return true;
  }
  return false;
}

export { isTemporaryWorktreeBranch } from "@t3tools/shared/worktree";
