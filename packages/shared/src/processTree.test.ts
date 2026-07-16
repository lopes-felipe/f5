import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { killProcessTree, type ProcessTreeChild } from "./processTree";

function makeChild(pid = 123): ProcessTreeChild & { kill: ReturnType<typeof vi.fn> } {
  return { pid, kill: vi.fn(() => true) };
}

describe("killProcessTree", () => {
  it("uses an absolute taskkill path and succeeds only on a zero exit status", () => {
    const child = makeChild();
    const spawnTaskkill = vi.fn(() => ({ status: 0, error: undefined }));
    expect(
      killProcessTree(child, {
        platform: "win32",
        isGroupLeader: false,
        environment: { SystemRoot: "D:\\Windows" },
        spawnTaskkill,
      }),
    ).toEqual({ terminated: true, usedFallback: false, taskkillStatus: 0 });
    expect(spawnTaskkill).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\taskkill.exe",
      ["/pid", "123", "/T", "/F"],
      { stdio: "ignore", timeout: 2_000 },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the child handle when taskkill fails", () => {
    const child = makeChild();
    const result = killProcessTree(child, {
      platform: "win32",
      isGroupLeader: false,
      spawnTaskkill: () => ({ status: 1, error: undefined }),
    });
    expect(result).toMatchObject({ terminated: true, usedFallback: true, taskkillStatus: 1 });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports an incomplete termination when taskkill and the fallback both fail", () => {
    const child = makeChild();
    child.kill.mockReturnValue(false);
    expect(
      killProcessTree(child, {
        platform: "win32",
        isGroupLeader: false,
        spawnTaskkill: () => ({ status: 1 }),
      }),
    ).toMatchObject({ terminated: false, usedFallback: true, taskkillStatus: 1 });
  });

  it("uses a negative POSIX pid only for group leaders", () => {
    const groupChild = makeChild();
    const killPid = vi.fn();
    expect(
      killProcessTree(groupChild, {
        platform: "linux",
        isGroupLeader: true,
        signal: "SIGKILL",
        killPid,
      }),
    ).toMatchObject({ terminated: true, usedFallback: false });
    expect(killPid).toHaveBeenCalledWith(-123, "SIGKILL");
    expect(groupChild.kill).not.toHaveBeenCalled();

    const directChild = makeChild();
    killProcessTree(directChild, { platform: "linux", isGroupLeader: false });
    expect(directChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.skipIf(process.platform !== "win32")(
    "terminates a real Windows parent and grandchild process",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "f5-process-tree-"));
      const parentScript = path.join(directory, "parent.cjs");
      writeFileSync(
        parentScript,
        [
          'const { spawn } = require("node:child_process");',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "process.stdout.write(String(child.pid) + '\\n');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const parent = spawn(process.execPath, [parentScript], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("grandchild pid timeout")), 5_000);
        parent.stdout?.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(killProcessTree(parent, { isGroupLeader: false }).terminated).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const tasklist = path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "tasklist.exe",
      );
      for (const pid of [parent.pid, grandchildPid]) {
        const result = spawnSync(tasklist, ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
        expect(result.stdout).not.toMatch(new RegExp(`\\b${pid}\\b`));
      }
    },
  );
});
