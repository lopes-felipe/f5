import { describe, expect, it } from "vitest";

import { detectBranchDrift } from "./ChatView.branchDrift.logic";

describe("detectBranchDrift", () => {
  it("ignores threads without a recorded branch", () => {
    expect(detectBranchDrift({ recordedBranch: null, currentBranch: "main" })).toBeNull();
  });

  it("ignores a matching checkout", () => {
    expect(
      detectBranchDrift({ recordedBranch: "feature/current", currentBranch: "feature/current" }),
    ).toBeNull();
  });

  it("reports another branch or detached HEAD", () => {
    expect(detectBranchDrift({ recordedBranch: "feature/thread", currentBranch: "main" })).toEqual({
      recordedBranch: "feature/thread",
      currentBranch: "main",
    });
    expect(detectBranchDrift({ recordedBranch: "feature/thread", currentBranch: null })).toEqual({
      recordedBranch: "feature/thread",
      currentBranch: null,
    });
  });
});
