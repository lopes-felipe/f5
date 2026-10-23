import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("passes the same bare-repository protection to direct Git callers", async () => {
    const result = await runProcess("git", ["config", "--get", "--", "safe.bareRepository"], {
      env: process.env,
      allowNonZeroExit: true,
    });
    expect(result.stdout.trim()).toBe("explicit");
  });

  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
        env: process.env,
        maxBufferBytes: 128,
      }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      env: process.env,
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
      env: process.env,
      timeoutMs: 100,
      allowNonZeroExit: true,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("terminates the process group when its abort signal is cancelled", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: process.env,
      timeoutMs: 10_000,
      allowNonZeroExit: true,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });
});

it("keeps failure markers at the end of oversized stdout and stderr", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('x'.repeat(4096) + 'END'); process.stderr.write('y'.repeat(4096) + 'FAILURE'); process.exitCode=1",
    ],
    {
      env: process.env,
      outputMode: "tail",
      maxStdoutBytes: 128,
      maxStderrBytes: 64,
      allowNonZeroExit: true,
    },
  );
  expect(result.code).toBe(1);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
  expect(result.stdout.endsWith("END")).toBe(true);
  expect(result.stderr.endsWith("FAILURE")).toBe(true);
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "waits for stubborn descendants even after their parent closes its pipes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "f5-process-tree-"));
    const marker = join(root, "alive");
    const descendant = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); let i = 0; setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(i++)), 10);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runProcess(process.execPath, ["-e", parent], {
      env: process.env,
      timeoutMs: 10_000,
      signal: controller.signal,
      allowNonZeroExit: true,
    });
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 3000 });
      controller.abort();
      const result = await running;
      expect(result.aborted).toBe(true);
      const last = readFileSync(marker, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(marker, "utf8")).toBe(last);
    } finally {
      controller.abort();
      await running.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "bounds draining when an escaped child retains stdout",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "f5-process-escaped-"));
    const pidPath = join(root, "pid");
    const daemon = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}], { detached: true, stdio: 'inherit' }).unref(); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runProcess(process.execPath, ["-e", parent], {
      env: process.env,
      signal: controller.signal,
      timeoutMs: 10000,
      allowNonZeroExit: true,
    });
    try {
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), { timeout: 3000 });
      const startedAt = Date.now();
      controller.abort();
      const result = await running;
      expect(result.aborted).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2500);
    } finally {
      controller.abort();
      if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
      await running.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const exitCode of [0, 7])
  it.skipIf(process.platform === "win32")(
    `preserves exit ${exitCode} when a helper holds stdout open`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "f5-process-exited-"));
      const pidPath = join(root, "helper-pid");
      const daemon = "setInterval(() => {}, 1000);";
      const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid)); child.unref(); process.stdout.write('finished'); process.exitCode = ${exitCode};`;
      const startedAt = Date.now();
      try {
        const result = await runProcess(process.execPath, ["-e", parent], {
          env: process.env,
          timeoutMs: 500,
          allowNonZeroExit: true,
        });
        expect(result.code).toBe(exitCode);
        expect(result.stdout).toBe("finished");
        expect(result.timedOut).toBe(false);
        expect(result.aborted).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(2500);
      } finally {
        if (existsSync(pidPath)) {
          try {
            process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
