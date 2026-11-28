import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  applyLoginShellPath,
  buildEnvironmentCaptureCommand,
  extractPathFromShellOutput,
  readEnvironmentFromLoginShellAsync,
} from "./shell";

describe("applyLoginShellPath", () => {
  it.each([
    [undefined, "/fnm/probe", "/fnm/probe/bin:/usr/bin", "/fnm/probe"],
    ["", "/fnm/probe", "/fnm/probe/bin:/usr/bin", "/fnm/probe"],
    ["/fnm/old", "/fnm/old", "/fnm/old/bin:/usr/bin", "/fnm/old"],
    ["/fnm/old", undefined, "/fnm/old/bin:/usr/bin", "/fnm/old"],
    ["/fnm/old", "/fnm/probe", "/fnm/probe/bin:/fnm/other/bin:/usr/bin", "/fnm/probe"],
  ])(
    "applies PATH with inherited fnm value %s and probe value %s",
    async (inherited, probe, path, expected) => {
      const env: NodeJS.ProcessEnv = { FNM_MULTISHELL_PATH: inherited };
      expect(
        await applyLoginShellPath(env, { PATH: path, FNM_MULTISHELL_PATH: probe }, inherited),
      ).toBe(true);
      expect(env).toMatchObject({ PATH: path, FNM_MULTISHELL_PATH: expected });
    },
  );

  it.each([": :", ":/fnm/probe/old/bin:", "/fnm/probe/old/bin:/usr/bin"])(
    "preserves the inherited environment for unusable PATH %s",
    async (path) => {
      const inherited = "/fnm/probe/old";
      const original = {
        PATH: "/usr/bin",
        FNM_MULTISHELL_PATH: inherited,
        __MISE_DIFF: "inherited",
      };
      const env = { ...original };
      expect(
        await applyLoginShellPath(
          env,
          {
            PATH: path,
            FNM_MULTISHELL_PATH: "/fnm/probe",
            __MISE_DIFF: "probe",
          },
          inherited,
        ),
      ).toBe(false);
      expect(env).toEqual(original);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps inherited Node until the replacement is executable",
    async ({ onTestFinished }) => {
      const root = await mkdtemp(join(tmpdir(), "f5-fnm-"));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const inherited = join(root, "inherited");
      const replacement = join(root, "replacement");
      const target = join(root, "default");
      await mkdir(join(inherited, "bin"), { recursive: true });
      await writeFile(join(inherited, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      await symlink(target, replacement, "dir");

      const inheritedPath = inherited + "/bin:/fnm/untracked/bin:/usr/bin";
      const probe = {
        PATH: replacement + "/bin:" + inheritedPath,
        FNM_MULTISHELL_PATH: replacement,
      };
      const env = { PATH: inheritedPath, FNM_MULTISHELL_PATH: inherited };

      expect(await applyLoginShellPath(env, probe, inherited)).toBe(true);
      expect(env).toEqual({ PATH: inheritedPath, FNM_MULTISHELL_PATH: inherited });

      const node = join(target, "bin", "node");
      await mkdir(join(target, "bin"), { recursive: true });
      await writeFile(node, "#!/bin/sh\n", { mode: 0o644 });
      expect(await applyLoginShellPath(env, probe, inherited)).toBe(true);
      expect(env).toEqual({ PATH: inheritedPath, FNM_MULTISHELL_PATH: inherited });

      await chmod(node, 0o755);
      expect(await applyLoginShellPath(env, probe, inherited)).toBe(true);
      expect(env).toEqual({
        PATH: replacement + "/bin:/fnm/untracked/bin:/usr/bin",
        FNM_MULTISHELL_PATH: replacement,
      });
    },
  );
});

function makeProbe() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const execute = vi.fn(() => child);
  return { child, execute, spawn: execute as unknown as typeof spawn };
}

describe("login shell environment", () => {
  it("kills at five seconds and stops waiting at six when a shell never exits", async () => {
    vi.useFakeTimers();
    const probe = makeProbe();
    try {
      const result = readEnvironmentFromLoginShellAsync("/bin/zsh", ["PATH"], probe.spawn);
      const rejection = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5000);
      expect(probe.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(probe.child.stdout.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(probe.child.stdout.destroyed).toBe(true);
      expect(probe.child.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["PATH", "/a:/b", { PATH: "/a:/b" }],
    ["CUSTOM_VAR", "  first\nsecond  ", { CUSTOM_VAR: "  first\nsecond  " }],
    ["EMPTY_VAR", "", {}],
  ])("captures %s without host shell configuration", async (name, value, expected) => {
    const probe = makeProbe();
    const result = readEnvironmentFromLoginShellAsync("/bin/zsh", [name], probe.spawn);
    probe.child.stdout.write(
      "__T3CODE_ENV_" + name + "_START__\n" + value + "\n__T3CODE_ENV_" + name + "_END__\n",
    );
    probe.child.emit("close", 0);
    expect(await result).toEqual(expected);
    expect(probe.execute).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", buildEnvironmentCaptureCommand("/bin/zsh", [name])],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  });

  it("ignores noise and missing variables while capturing multiple values", async () => {
    const probe = makeProbe();
    const result = readEnvironmentFromLoginShellAsync(
      "/bin/fish",
      ["PATH", "SSH_AUTH_SOCK", "MISSING"],
      probe.spawn,
    );
    probe.child.stdout.write(
      "welcome\n__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n__T3CODE_ENV_SSH_AUTH_SOCK_START__\n/tmp/agent.sock\n__T3CODE_ENV_SSH_AUTH_SOCK_END__\nbye",
    );
    probe.child.emit("close", 0);
    expect(await result).toEqual({ PATH: "/a:/b", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  });

  it.runIf(existsSync("/bin/bash"))(
    "ignores terminal titles printed by a Bash DEBUG trap",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "f5-bash-env-"));
      try {
        const bashEnv = join(home, "env.bash");
        await writeFile(bashEnv, `trap 'printf "\\033]0;%s\\007" "$BASH_COMMAND"' DEBUG\n`);
        const shellPath = "/test/bin:/usr/bin:/bin";
        const bashWithFixture = (file: string, [, command]: string[], options: SpawnOptions) =>
          // Non-interactive Bash reads the fixture via BASH_ENV and skips host startup files.
          spawn(file, ["-c", command ?? ""], {
            ...options,
            env: { HOME: home, BASH_ENV: bashEnv, PATH: shellPath },
          });

        await expect(
          readEnvironmentFromLoginShellAsync(
            "/bin/bash",
            ["XDG_DATA_HOME", "PATH"],
            bashWithFixture as typeof spawn,
          ),
        ).resolves.toEqual({ PATH: shellPath });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("clears timers after a successful probe", async () => {
    vi.useFakeTimers();
    const probe = makeProbe();
    try {
      const result = readEnvironmentFromLoginShellAsync("/bin/zsh", ["PATH"], probe.spawn);
      probe.child.emit("close", 0);
      expect(await result).toEqual({});
      await vi.advanceTimersByTimeAsync(7000);
      expect(probe.child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects spawn failures and nonzero exits", async () => {
    const probe = makeProbe();
    const result = readEnvironmentFromLoginShellAsync("/bin/zsh", ["PATH"], probe.spawn);
    probe.child.emit("error", new Error("spawn failed"));
    await expect(result).rejects.toThrow("spawn failed");
    const next = makeProbe();
    const exited = readEnvironmentFromLoginShellAsync("/bin/zsh", ["PATH"], next.spawn);
    next.child.emit("close", 1);
    await expect(exited).rejects.toThrow("probe failed");
  });

  it("does not spawn for an empty request", async () => {
    const probe = makeProbe();
    expect(await readEnvironmentFromLoginShellAsync("/bin/zsh", [], probe.spawn)).toEqual({});
    expect(probe.execute).not.toHaveBeenCalled();
  });

  it("rejects output over its limit without waiting for exit", async () => {
    const probe = makeProbe();
    const result = readEnvironmentFromLoginShellAsync("/bin/zsh", ["PATH"], probe.spawn);
    probe.child.stdout.write("x".repeat(1024 * 1024 + 1));
    await expect(result).rejects.toThrow("exceeded its limit");
    expect(probe.child.stdout.destroyed).toBe(true);
    expect(probe.child.unref).toHaveBeenCalledOnce();
  });

  it("reads Nushell environment natively", () => {
    for (const shell of ["/opt/homebrew/bin/nu", "/Users/test/bin/Nushell"]) {
      const command = buildEnvironmentCaptureCommand(shell, ["PATH", "SSH_AUTH_SOCK"]);
      expect(command).not.toContain("printenv");
      expect(command).not.toContain("||");
      expect(command).toContain("print '__T3CODE_ENV_PATH_START__'");
      expect(command).toContain("$env.ENV_CONVERSIONS?.PATH?.to_string?");
      expect(command).toContain("$env.SSH_AUTH_SOCK? | default ''");
    }
    expect(buildEnvironmentCaptureCommand("/bin/zsh", ["PATH"])).toContain("printenv PATH || true");
  });
});

describe("extractPathFromShellOutput", () => {
  it("ignores noise around capture markers", () => {
    expect(
      extractPathFromShellOutput("welcome\n__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\nbye"),
    ).toBe("/a:/b");
    expect(extractPathFromShellOutput("/a:/b")).toBeNull();
  });
});
