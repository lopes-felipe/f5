import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import type { killProcessTreeAsync } from "@t3tools/shared/processTree";
import { closeProbeProcess } from "./McpProbeProcess.ts";

function child(exitCode: number | null = null) {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}
describe("probe process cleanup", () => {
  it.each(["win32", "darwin"] as const)(
    "does not signal an already exited %s process",
    async (platform) => {
      const process = child(0);
      const killTree = vi.fn();
      await closeProbeProcess(process, {}, { platform, killTree, groupExists: () => false });
      expect(killTree).not.toHaveBeenCalled();
    },
  );
  it("does not force kill a Windows PID after exit during graceful cleanup", async () => {
    const process = child();
    const killTree = vi.fn<typeof killProcessTreeAsync>(async () => {
      process.emit("exit", 0, null);
      return { terminated: true, usedFallback: false };
    });
    await closeProbeProcess(process, {}, { platform: "win32", killTree });
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree.mock.calls[0]?.[1]).toMatchObject({ graceful: true });
  });
  it("returns as soon as a POSIX group disappears, and still escalates live descendants", async () => {
    let alive = true;
    const process = child();
    const killTree = vi.fn<typeof killProcessTreeAsync>(async () => {
      alive = false;
      process.emit("exit", 0, null);
      return { terminated: true, usedFallback: false };
    });
    await closeProbeProcess(
      process,
      {},
      { platform: "darwin", killTree, groupExists: () => alive },
    );
    expect(killTree).toHaveBeenCalledTimes(1);
    killTree.mockClear();
    await closeProbeProcess(
      child(),
      {},
      { platform: "darwin", killTree, groupExists: () => true, graceMs: 1 },
    );
    expect(killTree).toHaveBeenCalledTimes(2);
    expect(killTree.mock.calls[1]?.[1]).toMatchObject({ graceful: false });
  });
});
