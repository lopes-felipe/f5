import { describe, expect, it } from "vitest";
import { parseWorktreeListPorcelain, stripPathTerminator } from "./worktreeList.ts";
describe("worktree porcelain -z", () => {
  it("preserves whitespace and newlines in paths and lock reasons", () => {
    const entries = parseWorktreeListPorcelain(
      "worktree /repo \n\0HEAD abc\0branch refs/heads/main\0\0worktree /linked\n \0HEAD def\0detached\0locked waiting\nfor backup \0prunable gitdir file points to non-existent location\0\0",
    );
    expect(entries).toEqual([
      {
        path: "/repo \n",
        headSha: "abc",
        branch: "main",
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
        isMain: true,
      },
      {
        path: "/linked\n ",
        headSha: "def",
        branch: null,
        bare: false,
        detached: true,
        locked: "waiting\nfor backup ",
        prunable: "gitdir file points to non-existent location",
        isMain: false,
      },
    ]);
  });
  it("distinguishes absent flags from flags without reasons and handles bare roots", () => {
    expect(
      parseWorktreeListPorcelain("worktree /bare\0bare\0\0worktree /linked\0locked\0prunable\0\0"),
    ).toMatchObject([
      { bare: true, headSha: null, isMain: true },
      { locked: "", prunable: "", isMain: false },
    ]);
    expect(parseWorktreeListPorcelain("")).toEqual([]);
  });
  it("strips exactly one output terminator", () => {
    expect(stripPathTerminator("/repo \n\n")).toBe("/repo \n");
    expect(stripPathTerminator("/repo ")).toBe("/repo ");
  });
});
