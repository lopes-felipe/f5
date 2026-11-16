import { describe, expect, it } from "vitest";

import {
  resolveThreadWorkspaceCwd,
  threadWorkspaceCwd,
  threadAttachmentWorkspaceRoots,
  threadTerminalRuntimeEnv,
  threadTerminalCommandCwd,
} from "./threadWorkspace";

const project = { id: "project", cwd: "/repo" };
const scratch = { id: "scratch", kind: "scratch", workspaceRoot: "/state/scratch" };

describe("threadWorkspaceCwd", () => {
  it("rejects unallocated terminals and shared-root overrides before terminal I/O", () => {
    expect(() => threadTerminalCommandCwd({ worktreePath: null }, scratch)).toThrow(
      "Terminal is available after the first message",
    );
    const thread = { worktreePath: null, scratchPath: "/state/scratch/mine" };
    expect(threadTerminalCommandCwd(thread, scratch)).toBe(thread.scratchPath);
    for (const cwd of [
      "/state/scratch",
      "/state/scratch/",
      "/state/scratch/.",
      "/state/scratch/mine/..",
    ]) {
      expect(() => threadTerminalCommandCwd(thread, scratch, cwd)).toThrow("shared folder");
    }
    expect(threadTerminalCommandCwd(thread, scratch, "/state/scratch/mine/subdir")).toBe(
      "/state/scratch/mine/subdir",
    );
    expect(() =>
      threadTerminalCommandCwd(
        { worktreePath: null, scratchPath: "C:\\state\\scratch\\mine" },
        { kind: "scratch", cwd: "C:\\state\\scratch" },
        "c:/STATE/scratch/",
      ),
    ).toThrow("shared folder");
    expect(threadTerminalCommandCwd({ worktreePath: "/wt" }, project)).toBe("/wt");
    expect(threadTerminalCommandCwd({ worktreePath: "/wt" }, project, "/script")).toBe("/script");
  });
  it("confines scratch attachments and terminal environment to the own folder", () => {
    const thread = { worktreePath: null, scratchPath: "/state/scratch/mine" };
    expect(threadAttachmentWorkspaceRoots(thread, scratch)).toEqual([thread.scratchPath]);
    expect(threadAttachmentWorkspaceRoots({ worktreePath: "/stray" }, scratch)).toEqual([]);
    expect(threadTerminalRuntimeEnv(thread, scratch)).toEqual({
      T3CODE_PROJECT_ROOT: thread.scratchPath,
    });
    expect(threadTerminalRuntimeEnv({ worktreePath: null }, scratch)).toEqual({});
    expect(
      threadTerminalRuntimeEnv(thread, scratch, {
        CUSTOM: "yes",
        T3CODE_PROJECT_ROOT: "/wrong",
        T3CODE_WORKTREE_PATH: "/wrong",
      }),
    ).toEqual({ CUSTOM: "yes", T3CODE_PROJECT_ROOT: thread.scratchPath });
  });

  it("preserves the ordered worktree/project attachment roots and terminal env", () => {
    expect(threadAttachmentWorkspaceRoots({ worktreePath: "/wt" }, project)).toEqual([
      "/wt",
      "/repo",
    ]);
    expect(threadAttachmentWorkspaceRoots({ worktreePath: null }, project)).toEqual(["/repo"]);
    expect(threadTerminalRuntimeEnv({ worktreePath: "/wt" }, project, { CUSTOM: "yes" })).toEqual({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/wt",
      CUSTOM: "yes",
    });
  });
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
