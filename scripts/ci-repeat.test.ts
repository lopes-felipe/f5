import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REPEATS, parseArgs, renderSummary, repeat } from "./ci-repeat.ts";

/**
 * Exits with the code listed for the current iteration, counted in the `COUNTER`
 * file, and logs each iteration's artifact directory to `COUNTER.dirs`.
 */
const exitWith = (codes: number[]) => [
  process.execPath,
  "-e",
  `if (process.env.F5_CI_TEST_RETRY !== "0") process.exit(99);
const codes=${JSON.stringify(codes)};const fs=require("node:fs");const f=process.env.COUNTER;
const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0);fs.writeFileSync(f,String(n+1));
fs.appendFileSync(f+".dirs",(process.env.F5_CI_ARTIFACT_DIR??"")+"\\n");
process.exit(codes[n]);`,
];

// os.tmpdir(): TMPDIR is unset on Windows runners.
const counter = () => join(tmpdir(), `f5-ci-repeat-${crypto.randomUUID()}`);

describe("ci-repeat", () => {
  it("runs every iteration with retries disabled and tallies failures", async () => {
    let clock = 0;
    const file = counter();
    const result = await repeat({
      times: 3,
      failFast: false,
      command: exitWith([0, 1, 0]),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COUNTER: file,
        F5_CI_TEST_RETRY: "1",
        F5_CI_ARTIFACT_DIR: join("base", "repro"),
      },
      write: () => {},
      now: () => (clock += 1000),
    });
    expect(result).toMatchObject({ passed: 2, failed: 1 });
    expect(result.runs.map((run) => run.code)).toEqual([0, 1, 0]);
    // Each iteration keeps its own diagnostics.
    expect(readFileSync(`${file}.dirs`, "utf8").trim().split("\n")).toEqual(
      [1, 2, 3].map((iteration) => join("base", "repro", `iteration-${iteration}`)),
    );
    const summary = renderSummary(result, ["bun", "run", "x"]);
    expect(summary).toContain("### Repeat: 2/3 passed");
    expect(summary).toContain("Failed iterations: 2 (exit 1)");
    expect(summary).toContain("| 2 | 1 | 1.0 s | 1.0 s | 1.0 s | 1.0 s |");
  });

  it("stops at the first failure with --fail-fast", async () => {
    const result = await repeat({
      times: 5,
      failFast: true,
      command: exitWith([0, 2, 0, 0, 0]),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COUNTER: counter() },
      write: () => {},
    });
    expect(result.runs).toHaveLength(2);
  });

  it("bounds the repeat count and requires a command", () => {
    expect(parseArgs(["--times", "30", "--fail-fast", "--", "bun", "test"])).toEqual({
      times: 30,
      failFast: true,
      command: ["bun", "test"],
    });
    for (const argv of [
      ["--times", "0", "--", "x"],
      ["--times", String(MAX_REPEATS + 1), "--", "x"],
      ["--times", "3"],
      ["--", "x"],
    ])
      expect(() => parseArgs(argv)).toThrow("Usage");
  });
});
