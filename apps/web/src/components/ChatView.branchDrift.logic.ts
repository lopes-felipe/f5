export interface BranchDrift {
  readonly recordedBranch: string;
  readonly currentBranch: string | null;
}

export function detectBranchDrift(input: {
  readonly recordedBranch: string | null;
  readonly currentBranch: string | null;
  /**
   * False when the workspace directory is missing or not a Git checkout. There
   * is no branch to compare then; the server's worktree readiness check owns
   * recreation or the missing-worktree error.
   */
  readonly checkoutAvailable: boolean;
}): BranchDrift | null {
  if (
    !input.checkoutAvailable ||
    input.recordedBranch === null ||
    input.recordedBranch === input.currentBranch
  ) {
    return null;
  }
  return {
    recordedBranch: input.recordedBranch,
    currentBranch: input.currentBranch,
  };
}
