import { describe, expect, it } from "vitest";

import { resolveThreadWorkspaceCwd, threadWorkspaceCwd } from "./threadWorkspace";

const project = { id: "project", cwd: "/repo" };
const scratch = { id: "scratch", kind: "scratch", workspaceRoot: "/state/scratch" };

describe("threadWorkspaceCwd", () => {
  it("prefers the scratch folder, then the worktree, then the project root", () => {
    expect(
      threadWorkspaceCwd({ worktreePath: null, scratchPath: "/state/scratch/a" }, scratch),
    ).toBe("/state/scratch/a");
    expect(threadWorkspaceCwd({ worktreePath: "/repo-wt" }, project)).toBe("/repo-wt");
    expect(threadWorkspaceCwd({ worktreePath: null }, project)).toBe("/repo");
    expect(threadWorkspaceCwd(null, { workspaceRoot: "/server-root" })).toBe("/server-root");
  });

  it("never falls back to the shared scratch root", () => {
    expect(threadWorkspaceCwd({ worktreePath: null, scratchPath: null }, scratch)).toBeUndefined();
    expect(threadWorkspaceCwd({ worktreePath: "/stray" }, scratch)).toBeUndefined();
    expect(threadWorkspaceCwd(undefined, scratch)).toBeUndefined();
    expect(threadWorkspaceCwd({ worktreePath: null }, undefined)).toBeUndefined();
  });

  it("looks the project up by id", () => {
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId: "project", worktreePath: null },
        projects: [scratch, project],
      }),
    ).toBe("/repo");
    expect(
      resolveThreadWorkspaceCwd({
        thread: { projectId: "missing", worktreePath: "/wt" },
        projects: [project],
      }),
    ).toBe("/wt");
  });
});
