import { type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  buildEnvironmentCaptureCommand,
  extractPathFromShellOutput,
  readEnvironmentFromLoginShellAsync,
} from "./shell";

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
