import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, runWithRetryOnce } from "./ci-retry-once.ts";
import { readFlakyRecords } from "./lib/ci-flaky-records.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "f5-retry-once-"));
  directories.push(directory);
  const env = {
    PATH: process.env.PATH,
    F5_CI_REPORT_DIR: join(directory, "reports"),
    F5_CI_ARTIFACT_DIR: join(directory, "artifacts"),
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
    GITHUB_JOB: "desktop",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
  };
  let output = "";
  return { directory, env, write: (text: string) => void (output += text), output: () => output };
}

/** Records each attempt's artifact dir and exits with the next listed code. */
const script = (directory: string, codes: number[]) => [
  process.execPath,
  "-e",
  `const fs=require("node:fs");const log=${JSON.stringify(join(directory, "attempts"))};
fs.appendFileSync(log, process.env.F5_CI_ARTIFACT_DIR+"\\n");
const n=fs.readFileSync(log,"utf8").trim().split("\\n").length;
console.log("attempt "+n+" output");process.exit(${JSON.stringify(codes)}[n-1]);`,
];
const attempts = (directory: string) =>
  existsSync(join(directory, "attempts"))
    ? readFileSync(join(directory, "attempts"), "utf8").trim().split("\n")
    : [];

describe("ci-retry-once", () => {
  it("runs a passing step once without recording it", async () => {
    const { directory, env, write } = setup();
    expect(
      await runWithRetryOnce({ step: "smoke", command: script(directory, [0]), env, write }),
    ).toBe(0);
    expect(attempts(directory)).toEqual([join(env.F5_CI_ARTIFACT_DIR, "attempt-1")]);
    expect(readFlakyRecords(env.F5_CI_REPORT_DIR)).toEqual([]);
  });

  it("records a step that passes on retry, keeping each attempt's artifacts apart", async () => {
    const { directory, env, write, output } = setup();
    expect(
      await runWithRetryOnce({ step: "smoke", command: script(directory, [3, 0]), env, write }),
    ).toBe(0);
    expect(attempts(directory)).toEqual([
      join(env.F5_CI_ARTIFACT_DIR, "attempt-1"),
      join(env.F5_CI_ARTIFACT_DIR, "attempt-2"),
    ]);
    expect(readFlakyRecords(env.F5_CI_REPORT_DIR)).toEqual([
      {
        version: 1,
        kind: "step",
        suite: "step/smoke",
        file: "desktop",
        name: "smoke",
        retryCount: 1,
        os: process.platform,
        job: "desktop",
        runId: "42",
        runAttempt: "1",
        errors: [expect.stringContaining("attempt 1 output")],
      },
    ]);
    expect(output()).toContain("::warning title=Flaky step::smoke failed with exit 3");
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("**Flaky step**");
  });

  it("fails with the second attempt's exit code when both attempts fail", async () => {
    const { directory, env, write } = setup();
    expect(
      await runWithRetryOnce({ step: "smoke", command: script(directory, [3, 5]), env, write }),
    ).toBe(5);
    expect(attempts(directory)).toHaveLength(2);
    expect(readFlakyRecords(env.F5_CI_REPORT_DIR)).toEqual([]);
  });

  it("runs a single attempt when CI retries are disabled", async () => {
    const { directory, env, write } = setup();
    expect(
      await runWithRetryOnce({
        step: "smoke",
        command: script(directory, [3, 0]),
        env: { ...env, F5_CI_TEST_RETRY: "0" },
        write,
      }),
    ).toBe(3);
    expect(attempts(directory)).toHaveLength(1);
  });

  it("treats a command that cannot start as a failed attempt", async () => {
    const { env, write } = setup();
    expect(
      await runWithRetryOnce({
        step: "smoke",
        command: ["f5-command-that-does-not-exist"],
        env: { ...env, F5_CI_TEST_RETRY: "0" },
        write,
      }),
    ).toBe(127);
  });

  it("parses the step and the command after the separator", () => {
    expect(parseArgs(["--step", "desktop-smoke", "--", "bun", "run", "x", "--step"])).toEqual({
      step: "desktop-smoke",
      command: ["bun", "run", "x", "--step"],
    });
    expect(() => parseArgs(["--", "bun"])).toThrow("Usage");
    expect(() => parseArgs(["--step", "x"])).toThrow("Usage");
  });
});
