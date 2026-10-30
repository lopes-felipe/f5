import * as NodeOS from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const readEnvironmentFromLoginShell = vi.fn(
  (_shell: string, _names: ReadonlyArray<string>): Partial<Record<string, string>> => ({
    PATH: "/login/shell/bin",
  }),
);
const ensureWindowsPathHydrated = vi.fn(async () => undefined);
vi.mock("@t3tools/shared/shell", () => ({ readEnvironmentFromLoginShell }));
vi.mock("@t3tools/shared/windowsPath", () => ({ ensureWindowsPathHydrated }));

const { fixPath, hydratePosixHome } = await import("./os-jank.ts");

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

  it("keeps the inherited PATH when the login shell returns a blank one", async () => {
    readEnvironmentFromLoginShell.mockReturnValueOnce({ PATH: "  ", __MISE_DIFF: "mise-diff" });
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await fixPath(env, "darwin");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.__MISE_DIFF).toBeUndefined();
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

  it("restores a missing HOME before probing the login shell", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: " " };
      let homeDuringProbe: string | undefined;
      readEnvironmentFromLoginShell.mockImplementationOnce(() => {
        homeDuringProbe = env.HOME;
        return { PATH: "/login/shell/bin" };
      });
      await fixPath(env, platform);
      expect(env.HOME).toBe(NodeOS.userInfo().homedir);
      if (platform === "darwin") expect(homeDuringProbe).toBe(NodeOS.userInfo().homedir);
    }
  });

  it("restores HOME even when the desktop prepared the environment", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin", F5_SHELL_ENVIRONMENT_PREPARED: "1" };
    await fixPath(env, "darwin");
    expect(env.HOME).toBe(NodeOS.userInfo().homedir);
  });

  it("leaves HOME alone on Windows", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    await fixPath(env, "win32");
    expect(env.HOME).toBeUndefined();
  });
});

describe("hydratePosixHome", () => {
  it("fills a missing HOME from the user account", () => {
    const env: NodeJS.ProcessEnv = {};
    hydratePosixHome(env);
    expect(env.HOME).toBe(NodeOS.userInfo().homedir);
  });

  it("preserves an explicitly configured HOME", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };
    hydratePosixHome(env, () => {
      throw new Error("HOME lookup should not run");
    });
    expect(env.HOME).toBe("/custom/home");
  });

  it("keeps HOME unset when the account lookup fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env: NodeJS.ProcessEnv = {};
    hydratePosixHome(env, () => {
      throw new Error("no passwd entry");
    });
    expect(env.HOME).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
