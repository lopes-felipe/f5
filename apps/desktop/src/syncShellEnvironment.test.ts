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
      __MISE_DIFF: "mise-diff",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    const prepared = await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(prepared).toBe(true);
    expect(env.__MISE_DIFF).toBe("mise-diff");
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
      "PATH",
      "__MISE_DIFF",
      "SSH_AUTH_SOCK",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
    ]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("imports missing CA trust variables while retaining inherited trust", async () => {
    const env: NodeJS.ProcessEnv = { SSL_CERT_DIR: "/inherited/certs" };
    await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => ({
        SSL_CERT_FILE: "/shell/root.pem",
        SSL_CERT_DIR: "/shell/certs",
        NODE_EXTRA_CA_CERTS: "/shell/company.pem",
      }),
    });
    expect(env).toMatchObject({
      SSL_CERT_FILE: "/shell/root.pem",
      SSL_CERT_DIR: "/inherited/certs",
      NODE_EXTRA_CA_CERTS: "/shell/company.pem",
    });
  });

  it.each([
    [{}, { LANG: "de_DE.UTF-8" }, { LANG: "de_DE.UTF-8" }],
    [{ LANG: "en_US.UTF-8" }, { LC_ALL: "de_DE.UTF-8" }, { LANG: "en_US.UTF-8" }],
    [{}, {}, { LC_CTYPE: "en_US.UTF-8" }],
  ])(
    "hydrates locale without overriding inherited categories",
    async (initial, shell, expected) => {
      const env: NodeJS.ProcessEnv = { ...initial };
      await syncShellEnvironment(env, { platform: "darwin", readEnvironment: () => shell });
      expect(env).toEqual(expected);
    },
  );

  it("keeps UTF-8 text working when the login shell fails", async () => {
    const env: NodeJS.ProcessEnv = {};
    const prepared = await syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => {
        throw Object.assign(new Error("spawnSync /bin/zsh ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    });
    expect(prepared).toBe(false);
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
  });

  it.each([{}, { PATH: "  " }, { SSH_AUTH_SOCK: "/tmp/agent.sock" }])(
    "leaves macOS preparation incomplete when the login shell returns no PATH (%o)",
    async (shell) => {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
      const prepared = await syncShellEnvironment(env, {
        platform: "darwin",
        readEnvironment: () => shell,
      });
      expect(prepared).toBe(false);
      expect(env.PATH).toBe("/usr/bin:/bin");
    },
  );

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

    const prepared = await syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(prepared).toBe(false);
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
    expect(await environmentReady).toBe(true);

    expect(Object.keys(env).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(env.PATH).toBe(
      "C:\\Inherited;C:\\Windows\\System32;C:\\Users\\Test\\AppData\\Roaming\\npm",
    );
  });

  it("leaves Windows preparation incomplete when the registry PATH cannot be read", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Inherited" };
    const warn = vi.fn();

    const prepared = await syncShellEnvironment(env, {
      platform: "win32",
      readWindowsRegistryPaths: () => Promise.reject(new Error("powershell timed out")),
      windowsPathExists: async () => false,
      warn,
    });

    expect(prepared).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Unable to read the Windows registry PATH; using the inherited PATH.",
    );
    expect(env.PATH).toBe("C:\\Inherited");
  });
});
