import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunResult } from "../processRunner.ts";
import { resolveBundledCodexExecutable } from "../provider/codexExecutable.ts";

const { jobs, run } = vi.hoisted(() => {
  const jobs: { resolve: (result: ProcessRunResult) => void; signal: AbortSignal | undefined }[] =
    [];
  return {
    jobs,
    run: vi.fn(
      (
        _file: string,
        _args: readonly string[],
        options: { signal?: AbortSignal; timeoutMs?: number },
      ) =>
        new Promise<ProcessRunResult>((resolve, reject) => {
          if (_file.includes("f5-missing-codex-binary")) {
            reject(new Error("Command not found"));
            return;
          }
          jobs.push({ resolve, signal: options.signal });
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        }),
    ),
  };
});
vi.mock("../processRunner.ts", () => ({ runProcess: run }));
import { probeCodexCliVersion, getCodexVersionProbeResources } from "./cliVersionProbe.ts";
const success: ProcessRunResult = {
  stdout: "codex-cli 0.99.0\n",
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
};
const input = () => ({
  binaryPath: process.execPath,
  cwd: process.cwd(),
  processEnvironment: process.env,
});
afterEach(() => {
  jobs.length = 0;
  run.mockClear();
});

describe("asynchronous Codex version probes", () => {
  it("probes the bundled native executable for the default setting", async () => {
    const probe = probeCodexCliVersion({ ...input(), binaryPath: "codex" });
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect(run.mock.calls[0]?.[0]).toBe(resolveBundledCodexExecutable());
    jobs[0]!.resolve(success);
    await expect(probe).resolves.toBe("0.99.0");
  });
  it("deduplicates concurrent probes and does not cache later invocations", async () => {
    const first = probeCodexCliVersion(input()),
      second = probeCodexCliVersion(input());
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    jobs[0]!.resolve(success);
    expect(await Promise.all([first, second])).toEqual(["0.99.0", "0.99.0"]);
    const next = probeCodexCliVersion(input());
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    jobs[1]!.resolve(success);
    await next;
  });
  it("cancels one waiter independently and kills the probe after its last waiter aborts", async () => {
    const a = new AbortController(),
      b = new AbortController();
    const first = probeCodexCliVersion({ ...input(), signal: a.signal });
    const second = probeCodexCliVersion({ ...input(), signal: b.signal });
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    await vi.waitFor(() => expect(getCodexVersionProbeResources().waiters).toBe(2));
    a.abort();
    await vi.waitFor(() => expect(a.signal.aborted).toBe(true));
    expect(jobs[0]!.signal?.aborted).toBe(false);
    b.abort();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(jobs[0]!.signal?.aborted).toBe(true);
  });
  it("keeps a finite timeout and actionable errors for hanging, missing and obsolete binaries", async () => {
    const hanging = probeCodexCliVersion(input());
    const rejected = expect(hanging).rejects.toThrow("timed out");
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    expect(run.mock.calls[0]?.[2].timeoutMs).toBe(4000);
    jobs[0]!.resolve({ ...success, timedOut: true, code: null });
    await rejected;
    await expect(
      probeCodexCliVersion({ ...input(), binaryPath: join(tmpdir(), "f5-missing-codex-binary") }),
    ).rejects.toThrow(/not found|not executable|not installed/i);
    const old = probeCodexCliVersion(input());
    const unsupported = expect(old).rejects.toThrow("too old");
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    jobs[1]!.resolve({ ...success, stdout: "codex 0.1.0" });
    await unsupported;
  });
  it("does not share a probe after the resolved executable script is replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "f5-version-probe-"));
    const binaryPath = join(directory, "codex.cjs");
    try {
      await writeFile(binaryPath, 'console.log("0.99.0")');
      const first = probeCodexCliVersion({ ...input(), binaryPath });
      await vi.waitFor(() => expect(jobs).toHaveLength(1));
      await writeFile(binaryPath, 'console.log("1.100.0")');
      const second = probeCodexCliVersion({ ...input(), binaryPath });
      await vi.waitFor(() => expect(jobs).toHaveLength(2));
      jobs[0]!.resolve(success);
      jobs[1]!.resolve(success);
      await Promise.all([first, second]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
