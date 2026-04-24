import { describe, expect, it } from "vitest";

import { projectScriptCwd, projectScriptRuntimeEnv, setupProjectScript } from "./projectScripts";

describe("projectScripts", () => {
  it("prefers the worktree path for script cwd", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
  });

  it("falls back to the project root for script cwd", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("finds the setup script when present", () => {
    expect(
      setupProjectScript([
        {
          id: "build",
          name: "Build",
          command: "bun run build",
          icon: "build",
          runOnWorktreeCreate: false,
        },
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]),
    ).toMatchObject({
      id: "setup",
      name: "Setup",
    });
  });
});
