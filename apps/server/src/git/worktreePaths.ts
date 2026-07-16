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
