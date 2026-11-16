import { describe, expect, it } from "vitest";
import { gitHubAutoMergeAvailable, gitHubAutoMergeHasWriteAccess } from "./githubAutoMerge.ts";

describe("GitHub auto-merge eligibility", () => {
  const result = (viewerPermission: string, state: string, mergeStateStatus: string) => ({
    data: {
      repository: {
        viewerPermission,
        autoMergeAllowed: true,
        pullRequest: { state, mergeStateStatus, headRefOid: "head" },
      },
    },
  });

  it.each(["CLEAN", "HAS_HOOKS", "UNSTABLE"])(
    "distinguishes a %s PR from missing write permission",
    (mergeStateStatus) => {
      const response = result("WRITE", "OPEN", mergeStateStatus);
      expect(gitHubAutoMergeHasWriteAccess(response)).toBe(true);
      expect(gitHubAutoMergeAvailable(response)).toBe(false);
    },
  );
  it("rejects closed PRs and stale heads despite write permission", () => {
    expect(gitHubAutoMergeAvailable(result("ADMIN", "CLOSED", "BLOCKED"))).toBe(false);
    expect(gitHubAutoMergeAvailable(result("ADMIN", "OPEN", "BLOCKED"), "other")).toBe(false);
  });
  it("allows waiting only with write permission", () => {
    expect(gitHubAutoMergeHasWriteAccess(result("READ", "OPEN", "BLOCKED"))).toBe(false);
    expect(gitHubAutoMergeAvailable(result("READ", "OPEN", "BLOCKED"))).toBe(false);
    expect(gitHubAutoMergeAvailable(result("WRITE", "OPEN", "BLOCKED"), "head")).toBe(true);
  });
});
