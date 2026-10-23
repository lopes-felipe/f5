import { afterEach, describe, expect, it, vi } from "vitest";

const readEnvironmentFromLoginShell = vi.fn(
  (_shell: string, _names: ReadonlyArray<string>): Partial<Record<string, string>> => ({
    PATH: "/login/shell/bin",
  }),
);
const ensureWindowsPathHydrated = vi.fn(async () => undefined);
vi.mock("@t3tools/shared/shell", () => ({ readEnvironmentFromLoginShell }));
vi.mock("@t3tools/shared/windowsPath", () => ({ ensureWindowsPathHydrated }));

const { fixPath } = await import("./os-jank.ts");

afterEach(() => vi.clearAllMocks());

describe("fixPath", () => {
  it("reads the login shell PATH when the server starts on its own", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await fixPath(env, "darwin");
    expect(readEnvironmentFromLoginShell).toHaveBeenCalledOnce();
    expect(env.PATH).toBe("/login/shell/bin");
  });

  it("carries mise's PATH record along with the shell's PATH", async () => {
    readEnvironmentFromLoginShell.mockReturnValueOnce({
      PATH: "/login/shell/bin",
      __MISE_DIFF: "mise-diff",
    });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await fixPath(env, "darwin");
    expect(readEnvironmentFromLoginShell).toHaveBeenCalledWith("/bin/zsh", ["PATH", "__MISE_DIFF"]);
    expect(env.__MISE_DIFF).toBe("mise-diff");
  });

  it("skips the probes the desktop already ran into the inherited environment", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin", F5_SHELL_ENVIRONMENT_PREPARED: "1" };
      await fixPath(env, platform);
      expect(env.PATH).toBe("/desktop/bin");
    }
    expect(readEnvironmentFromLoginShell).not.toHaveBeenCalled();
    expect(ensureWindowsPathHydrated).not.toHaveBeenCalled();
  });
});
