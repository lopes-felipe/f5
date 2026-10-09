import { describe, expect, it } from "vitest";
import { parseNativeReviewTarget } from "./nativeReviewTarget";
describe("native review targets", () => {
  it("never mistakes a hexadecimal branch name for a commit", () => {
    expect(parseNativeReviewTarget("deadbeef")).toEqual({ type: "baseBranch", branch: "deadbeef" });
    expect(parseNativeReviewTarget("branch: deadbeef")).toEqual({
      type: "baseBranch",
      branch: "deadbeef",
    });
    expect(parseNativeReviewTarget("commit deadbeef")).toEqual({ type: "commit", sha: "deadbeef" });
    expect(parseNativeReviewTarget(" ")).toEqual({ type: "uncommittedChanges" });
  });
  it("rejects missing and invalid explicit commit targets", () => {
    expect(() => parseNativeReviewTarget("commit:")).toThrow("Provide");
    expect(() => parseNativeReviewTarget("commit:main")).toThrow("SHA");
  });
});
