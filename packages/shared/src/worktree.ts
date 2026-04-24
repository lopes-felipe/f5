const TEMPORARY_WORKTREE_BRANCH_PREFIX = "t3code";

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${TEMPORARY_WORKTREE_BRANCH_PREFIX}/${token}`;
}
