import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { FilesystemPath } from "./baseSchemas";
import { GitRemoveWorktreeInput } from "./git";
import { WorktreesInspectInput, WorktreesRecoverInput } from "./worktrees";
describe("worktree safety wire contracts", () => {
  it("preserves paths including leading, trailing and newline whitespace", () => {
    const path = " /tmp/worktree\n ";
    expect(Schema.decodeUnknownSync(FilesystemPath)(path)).toBe(path);
    expect(Schema.decodeUnknownSync(GitRemoveWorktreeInput)({ cwd: path, path })).toEqual({
      cwd: path,
      path,
    });
    expect(Schema.decodeUnknownSync(WorktreesInspectInput)({ projectId: "p", path }).path).toBe(
      path,
    );
  });
  it("rejects empty and NUL paths", () => {
    for (const path of ["", "/tmp/\0bad"])
      expect(() => Schema.decodeUnknownSync(FilesystemPath)(path)).toThrow();
  });
  it("does not expose force and requires a recovery revision", () => {
    expect(Object.keys(GitRemoveWorktreeInput.fields)).toEqual(["cwd", "path"]);
    expect(() =>
      Schema.decodeUnknownSync(WorktreesRecoverInput)({
        threadId: "t",
        action: "useProjectCheckout",
      }),
    ).toThrow();
  });
});
