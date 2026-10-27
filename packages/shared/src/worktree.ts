export const TEMPORARY_WORKTREE_BRANCH_PREFIX = "t3code";

const TEMPORARY_BRANCH_PATTERN =
  /^t3code(?:-[0-9a-f]{8}|\/(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))$/;

export function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMPORARY_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

/** A plain t3code ref occupies the directory required by t3code/<token>. */
export function flattenTemporaryWorktreeBranchName(branch: string): string {
  const token = branch
    .trim()
    .toLowerCase()
    .slice(
      TEMPORARY_WORKTREE_BRANCH_PREFIX.length + 1,
      TEMPORARY_WORKTREE_BRANCH_PREFIX.length + 9,
    );
  return TEMPORARY_WORKTREE_BRANCH_PREFIX + "-" + token;
}

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${TEMPORARY_WORKTREE_BRANCH_PREFIX}/${token}`;
}
