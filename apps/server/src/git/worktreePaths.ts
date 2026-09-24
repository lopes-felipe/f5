import { realpath } from "node:fs/promises";
import * as Path from "node:path";
import { defaultF5BaseDir } from "@t3tools/shared/appStatePaths";

export function resolveDefaultWorktreesDir(homeDir?: string): string {
  return Path.join(defaultF5BaseDir(homeDir), "worktrees");
}

export function sanitizeWorktreeBranchPathSegment(branch: string): string {
  return branch.replace(/\//g, "-");
}

export function resolveDefaultWorktreePath(input: {
  readonly worktreesDir: string;
  readonly cwd: string;
  readonly branch: string;
}): string {
  return Path.join(
    input.worktreesDir,
    Path.basename(input.cwd),
    sanitizeWorktreeBranchPathSegment(input.branch),
  );
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
