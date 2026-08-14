import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment } from "./syncShellEnvironment";

describe("syncShellEnvironment", () => {
  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("preserves inherited values when the login shell omits them", async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
    }));

    await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("does nothing outside macOS", async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    await syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates Windows PATH before the backend process starts without blocking the caller", async () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Inherited",
      APPDATA: "C:\\Users\\Test\\AppData\\Roaming",
    };

    let finishRegistryRead: ((value: { machine: string }) => void) | undefined;
    const environmentReady = syncShellEnvironment(env, {
      platform: "win32",
      readWindowsRegistryPaths: () =>
        new Promise((resolve) => {
          finishRegistryRead = resolve;
        }),
      windowsPathExists: async (candidate) => candidate.endsWith("\\npm"),
    });

    expect(env.PATH).toBeUndefined();
    finishRegistryRead?.({ machine: "C:\\Windows\\System32" });
    await environmentReady;

    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe(
      "C:\\Inherited;C:\\Windows\\System32;C:\\Users\\Test\\AppData\\Roaming\\npm",
    );
  });
});
