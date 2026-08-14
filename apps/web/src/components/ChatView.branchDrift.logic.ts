export interface BranchDrift {
  readonly recordedBranch: string;
  readonly currentBranch: string | null;
}

export function detectBranchDrift(input: {
  readonly recordedBranch: string | null;
  readonly currentBranch: string | null;
}): BranchDrift | null {
  if (input.recordedBranch === null || input.recordedBranch === input.currentBranch) {
    return null;
  }
  return {
    recordedBranch: input.recordedBranch,
    currentBranch: input.currentBranch,
  };
}
