import { describe, expect, it } from "vitest";

import { detectBranchDrift } from "./ChatView.branchDrift.logic";

describe("detectBranchDrift", () => {
  it("ignores threads without a recorded branch", () => {
    expect(
      detectBranchDrift({ recordedBranch: null, currentBranch: "main", checkoutAvailable: true }),
    ).toBeNull();
  });

  it("ignores a matching checkout", () => {
    expect(
      detectBranchDrift({
        recordedBranch: "feature/current",
        currentBranch: "feature/current",
        checkoutAvailable: true,
      }),
    ).toBeNull();
  });

  it("ignores a missing or non-repository workspace instead of reporting detached HEAD", () => {
    expect(
      detectBranchDrift({
        recordedBranch: "feature/thread",
        currentBranch: null,
        checkoutAvailable: false,
      }),
    ).toBeNull();
  });

  it("reports another branch or detached HEAD", () => {
    expect(
      detectBranchDrift({
        recordedBranch: "feature/thread",
        currentBranch: "main",
        checkoutAvailable: true,
      }),
    ).toEqual({
      recordedBranch: "feature/thread",
      currentBranch: "main",
    });
    expect(
      detectBranchDrift({
        recordedBranch: "feature/thread",
        currentBranch: null,
        checkoutAvailable: true,
      }),
    ).toEqual({
      recordedBranch: "feature/thread",
      currentBranch: null,
    });
  });
});
