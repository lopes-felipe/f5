import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { isRunning, stopChild, waitForChild } from "./lib/child-lifecycle.ts";

describe("child lifecycle", () => {
  it("rejects instead of hanging when the child fails to spawn", async () => {
    const child = spawn("f5-definitely-missing-binary-for-test", []);
    await expect(waitForChild(child)).rejects.toThrow(/ENOENT/);
  });

  it("does not wait on a child that failed to spawn", async () => {
    const child = spawn("f5-definitely-missing-binary-for-test", []);
    await waitForChild(child).catch(() => undefined);
    expect(isRunning(child)).toBe(false);
    await stopChild(child, 2000);
  });

  it("resolves with the exit code", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
    await expect(waitForChild(child)).resolves.toEqual({ code: 3, signal: null });
  });

  it("stops a running child", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise((resolve) => child.once("spawn", resolve));
    await stopChild(child, 2000);
    expect(isRunning(child)).toBe(false);
  });

  it("handles an early exit before teardown starts", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const exited = waitForChild(child);
    await exited;
    await stopChild(child, 50);
    expect(isRunning(child)).toBe(false);
  });

  it("tears down a failed startup without waiting for an exit that already happened", async () => {
    const child = spawn(process.execPath, ["-e", "throw new Error('startup failed')"], {
      stdio: "ignore",
    });
    const exited = waitForChild(child);
    expect((await exited).code).not.toBe(0);
    await stopChild(child, 50);
  });

  // Windows terminates SIGTERM directly; POSIX can exercise a child that ignores it.
  it.skipIf(process.platform === "win32")("escalates when the child ignores SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exited = waitForChild(child);
    try {
      await new Promise((resolve) => child.once("message", resolve));
      await stopChild(child, 50);
      expect((await exited).signal).toBe("SIGKILL");
    } finally {
      await stopChild(child, 50);
    }
  });
});
