import { describe, expect, it, vi } from "vitest";

import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
} from "./worktree";

describe("buildTemporaryWorktreeBranchName", () => {
  it("uses the t3code prefix and the first eight lowercase hex characters of the uuid", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("ABCDEF12-0000-0000-0000-000000000000");

    expect(buildTemporaryWorktreeBranchName()).toBe("t3code/abcdef12");
  });
});

it.each(["t3code/abcd1234", "t3code-abcd1234", "t3code/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12"])(
  "recognizes temporary branch %s",
  (branch) => {
    expect(isTemporaryWorktreeBranch(branch)).toBe(true);
    expect(isTemporaryWorktreeBranch(flattenTemporaryWorktreeBranchName(branch))).toBe(true);
  },
);

it.each(["main", "t3code", "t3code-feature", "t3code-abcd1234-extra", "t3code/feature/demo"])(
  "does not rename explicit branch %s",
  (branch) => expect(isTemporaryWorktreeBranch(branch)).toBe(false),
);
