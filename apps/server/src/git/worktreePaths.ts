import * as Path from "node:path";

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
