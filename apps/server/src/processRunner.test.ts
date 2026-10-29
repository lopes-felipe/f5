import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runProcess, terminateRunningProcesses } from "./processRunner";

describe("runProcess", () => {
  it.each(["error", "tail"] as const)(
    "streams complete output with bounded diagnostic tails in %s mode",
    async (outputMode) => {
      let stdout = "",
        stderr = "";
      const result = await runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(12000));process.stderr.write('y'.repeat(9000))"],
        {
          env: process.env,
          outputMode,
          maxBufferBytes: 64,
          onStdoutChunk: (chunk) => {
            stdout += Buffer.from(chunk).toString();
          },
          onStderrChunk: (chunk) => {
            stderr += Buffer.from(chunk).toString();
          },
        },
      );
      expect(stdout).toBe("x".repeat(12000));
      expect(stderr).toBe("y".repeat(9000));
      expect(result.stdout).toBe("x".repeat(4096));
      expect(result.stderr).toBe("y".repeat(4096));
    },
  );
  it("passes the same bare-repository protection to direct Git callers", async () => {
    const result = await runProcess("git", ["config", "--get", "--", "safe.bareRepository"], {
      env: process.env,
      allowNonZeroExit: true,
    });
    expect(result.stdout.trim()).toBe("explicit");
  });

  it.skipIf(process.platform === "win32")(
    "reports a synchronous ENOTDIR spawn failure as a spawn error",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "f5-process-runner-enotdir-"));
      try {
        const file = join(dir, "not-a-directory");
        writeFileSync(file, "");
        await expect(
          runProcess("f5-missing-command", ["--version"], { env: { PATH: file } }),
        ).rejects.toThrow("Failed to run f5-missing-command --version: spawn ENOTDIR");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

describe.skipIf(process.platform === "win32")("helper processes on backend shutdown", () => {
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const waitFor = async (label: string, check: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const readPid = (pidPath: string) => Number(readFileSync(pidPath, "utf8"));
  const helperSource = (pidPath: string, onSigterm: string) =>
    `const fs = require("node:fs");
process.on("SIGTERM", () => { ${onSigterm} });
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);`;

  const withHelper = async (
    onSigterm: string,
    run: (paths: { root: string; script: string; pidPath: string }) => Promise<void>,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "f5-process-shutdown-"));
    const pidPath = join(root, "helper.pid");
    const script = join(root, "helper.cjs");
    writeFileSync(script, helperSource(pidPath, onSigterm));
    try {
      await run({ root, script, pidPath });
    } finally {
      if (existsSync(pidPath) && isRunning(readPid(pidPath)))
        process.kill(readPid(pidPath), "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("gives running commands their SIGTERM grace period", () =>
    withHelper(
      'setTimeout(() => { fs.writeFileSync(__dirname + "/cleaned-up", ""); process.exit(0); }, 200);',
      async ({ root, script, pidPath }) => {
        const pending = runProcess(process.execPath, [script], {
          env: process.env,
          allowNonZeroExit: true,
        });
        await waitFor("the helper to start", () => existsSync(pidPath));

        await terminateRunningProcesses(Date.now() + 1_500);

        await expect(pending).resolves.toMatchObject({ code: 0 });
        expect(existsSync(join(root, "cleaned-up"))).toBe(true);
      },
    ));

  it("SIGKILLs commands that ignore SIGTERM before the shutdown deadline", () =>
    withHelper("", async ({ script, pidPath }) => {
      const pending = runProcess(process.execPath, [script], {
        env: process.env,
        allowNonZeroExit: true,
      });
      await waitFor("the helper to start", () => existsSync(pidPath));

      const startedAt = Date.now();
      await terminateRunningProcesses(Date.now() + 1_500);

      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(isRunning(readPid(pidPath))).toBe(false);
      await expect(pending).resolves.toMatchObject({ signal: "SIGKILL" });
    }));

  it(
    "kills stubborn helpers when the backend exits before their SIGKILL timer",
    () =>
      withHelper("", async ({ root, script, pidPath }) => {
        // An interrupted caller aborts the run, then the backend exits at once.
        const backend = join(root, "backend.ts");
        writeFileSync(
          backend,
          `import { runProcess } from ${JSON.stringify(join(import.meta.dirname, "processRunner.ts"))};
const controller = new AbortController();
void runProcess(process.execPath, [${JSON.stringify(script)}], { env: process.env, signal: controller.signal }).catch(() => {});
process.on("SIGTERM", () => { controller.abort(); process.exit(0); });
`,
        );
        const child = spawn("bun", [backend], { stdio: "ignore" });
        const exited = new Promise((resolve) => child.once("exit", resolve));
        try {
          await waitFor("the helper to start", () => existsSync(pidPath), 15_000);
          child.kill("SIGTERM");
          await exited;
          await waitFor("the helper to exit", () => !isRunning(readPid(pidPath)));
        } finally {
          child.kill("SIGKILL");
        }
      }),
    20_000,
  );
});
