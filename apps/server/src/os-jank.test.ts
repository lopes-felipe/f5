import * as NodeOS from "node:os";
import type { WindowsPathHydration } from "@t3tools/shared/windowsPath";
import { afterEach, describe, expect, it, vi } from "vitest";

const readEnvironmentFromLoginShell = vi.fn(
  (_shell: string, _names: ReadonlyArray<string>): Partial<Record<string, string>> => ({
    PATH: "/login/shell/bin",
  }),
);
const ensureWindowsPathHydration = vi.fn(
  async (): Promise<WindowsPathHydration> => ({ path: undefined, registryRead: false }),
);
vi.mock("@t3tools/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/shell")>()),
  readEnvironmentFromLoginShellAsync: readEnvironmentFromLoginShell,
}));
vi.mock("@t3tools/shared/windowsPath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/windowsPath")>()),
  ensureWindowsPathHydration,
}));

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
    expect(readEnvironmentFromLoginShell).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "__MISE_DIFF",
      "FNM_MULTISHELL_PATH",
    ]);
    expect(env.__MISE_DIFF).toBe("mise-diff");
  });

  it("replaces the inherited fnm multishell directory on each login-shell read", async () => {
    const inherited = "/tmp/fnm_multishells/launcher";
    const env: NodeJS.ProcessEnv = {
      PATH: `${inherited}:${inherited}/bin:${inherited}-other/bin:/usr/bin`,
      FNM_MULTISHELL_PATH: inherited,
    };
    for (const multishell of ["/tmp/fnm_multishells/first", "/tmp/fnm_multishells/second"]) {
      readEnvironmentFromLoginShell.mockReturnValueOnce({
        PATH: `${multishell}/bin:${env.PATH}`,
        FNM_MULTISHELL_PATH: multishell,
      });
      await fixPath(env, "darwin");
      expect(env.PATH).toBe(`${multishell}/bin:${inherited}-other/bin:/usr/bin`);
      expect(env.FNM_MULTISHELL_PATH).toBe(multishell);
    }
  });

  it("keeps the inherited PATH when the login shell returns a blank one", async () => {
    readEnvironmentFromLoginShell.mockReturnValueOnce({
      PATH: "  ",
      __MISE_DIFF: "mise-diff",
      FNM_MULTISHELL_PATH: "/tmp/fnm_multishells/new",
    });
    const env: NodeJS.ProcessEnv = {
      PATH: "/tmp/fnm_multishells/inherited/bin:/usr/bin",
      SHELL: "/bin/zsh",
      FNM_MULTISHELL_PATH: "/tmp/fnm_multishells/inherited",
    };
    await fixPath(env, "darwin");
    expect(env.PATH).toBe("/tmp/fnm_multishells/inherited/bin:/usr/bin");
    expect(env.FNM_MULTISHELL_PATH).toBe("/tmp/fnm_multishells/inherited");
    expect(env.__MISE_DIFF).toBeUndefined();
  });

  it("skips the probes the desktop already ran into the inherited environment", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin", F5_SHELL_ENVIRONMENT_PREPARED: "1" };
      await fixPath(env, platform);
      expect(env.PATH).toBe("/desktop/bin");
    }
    expect(readEnvironmentFromLoginShell).not.toHaveBeenCalled();
    expect(ensureWindowsPathHydration).not.toHaveBeenCalled();
  });

  it("imports the saved Windows opt-out when the server retries desktop preparation", async () => {
    // A failed desktop probe leaves F5_SHELL_ENVIRONMENT_PREPARED out of the backend environment.
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    ensureWindowsPathHydration.mockResolvedValueOnce({
      path: env.PATH,
      registryRead: true,
      savedDoNotTrack: "1",
    });

    await fixPath(env, "win32");

    expect(ensureWindowsPathHydration).toHaveBeenCalledOnce();
    expect(env.DO_NOT_TRACK).toBe("1");
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

  it("passes the startup cancellation signal to Windows PATH hydration", async () => {
    const env = { Path: "C:\\Windows" };
    const { signal } = new AbortController();
    await fixPath(env, "win32", signal);
    expect(ensureWindowsPathHydration).toHaveBeenCalledExactlyOnceWith(
      env,
      expect.objectContaining({ platform: "win32", signal }),
    );
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
