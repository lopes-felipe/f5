import { describe, expect, it } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("terminates nested subprocesses without waiting for inherited pipes", async () => {
    const nestedProcess = [
      'const { spawnSync } = require("node:child_process");',
      'spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    ].join("\n");
    const startedAt = Date.now();

    const result = await runProcess(process.execPath, ["-e", nestedProcess], {
      timeoutMs: 100,
      allowNonZeroExit: true,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
