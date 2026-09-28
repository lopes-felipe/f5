import { describe, expect, it } from "vitest";
import { resolveMergeMethod } from "./mergeMethod";
describe("merge method preference", () => {
  it("uses current, configured, last-used, then squash within the allowed methods", () => {
    const allowed = ["squash", "merge", "rebase"] as const;
    expect(
      resolveMergeMethod({ current: "merge", configured: "rebase", lastUsed: "squash", allowed }),
    ).toBe("merge");
    expect(resolveMergeMethod({ configured: "rebase", lastUsed: "merge", allowed })).toBe("rebase");
    expect(resolveMergeMethod({ lastUsed: "merge", allowed })).toBe("merge");
    expect(resolveMergeMethod({ allowed })).toBe("squash");
    expect(
      resolveMergeMethod({
        current: "merge",
        configured: "squash",
        lastUsed: "rebase",
        allowed: ["rebase"],
      }),
    ).toBe("rebase");
  });
  it("does not offer a merge method before repository permissions are known", () => {
    expect(resolveMergeMethod({ current: "squash", allowed: [] })).toBeNull();
  });
});
