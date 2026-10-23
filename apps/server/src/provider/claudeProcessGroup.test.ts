import { describe, expect, it } from "vitest";

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
});
