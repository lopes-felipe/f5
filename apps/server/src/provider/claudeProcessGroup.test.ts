import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";

import { makeClaudeProcessGroupSpawner } from "./claudeProcessGroup.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("makeClaudeProcessGroupSpawner", () => {
  it("kills processes the CLI leaves behind in its group when it exits", async () => {
    let stderr = "";
    const spawn = makeClaudeProcessGroupSpawner((data) => {
      stderr += data;
    })!;
    const child = spawn({
      command: "/bin/sh",
      args: ["-c", 'sleep 30 & echo "$!"; echo diagnostics >&2; read _'],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    const orphan = await new Promise<number>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    expect(isAlive(orphan)).toBe(true);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end("\n");
    await exited;

    await expect.poll(() => isAlive(orphan)).toBe(false);
    expect(stderr).toContain("diagnostics");
  });

  it("leaves Windows on the SDK's own spawn", () => {
    expect(makeClaudeProcessGroupSpawner(() => {}, "win32")).toBeUndefined();
  });

  it("stops a CLI that ignores stdin closing when its server-held pipe closes", async () => {
    const child = makeClaudeProcessGroupSpawner(() => {})!({
      command: "/bin/sh",
      args: ["-c", "echo ready; while :; do sleep 1; done"],
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    }) as ChildProcess;
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("exit", (_code, signal) => resolve(signal)),
      );
      // Isolate the liveness pipe: stdin/stdout/stderr remain open.
      child.stdio[3]?.destroy();
      expect(await exited).toBe("SIGTERM");
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    }
  });
});
