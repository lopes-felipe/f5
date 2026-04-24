import { describe, expect, it, vi } from "vitest";

import { buildTemporaryWorktreeBranchName } from "./worktree";

describe("buildTemporaryWorktreeBranchName", () => {
  it("uses the t3code prefix and the first eight lowercase hex characters of the uuid", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("ABCDEF12-0000-0000-0000-000000000000");

    expect(buildTemporaryWorktreeBranchName()).toBe("t3code/abcdef12");
  });
});
