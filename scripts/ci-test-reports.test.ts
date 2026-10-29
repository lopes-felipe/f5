import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFlakyRecords,
  FLAKY_RECORD_FILE,
  flakyRecord,
  readFlakyRecords,
} from "./lib/ci-flaky-records.ts";
import { CiFlakyReporter, ciTestReports, ciTestRetry, reportPath } from "./lib/ci-test-reports.ts";
import { classifyReport, renderFlaky, summarize } from "./ci-test-summary.ts";

const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
  "vitest.mjs",
);
const runFixture = (root: string) => {
  const result = spawnSync(
    process.execPath,
    [vitestCli, "run", "--root", root, "--config", join(root, "vitest.config.mjs")],
    {
      encoding: "utf8",
      // The fixture must not inherit this run's CI report identity.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot },
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
};

const fixture = () => ({
  success: true,
  startTime: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTests: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  testResults: [
    {
      name: "test.ts",
      status: "passed",
      startTime: 1,
      endTime: 2,
      assertionResults: [{ status: "passed" }],
    },
  ],
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("CI reports", () => {
  it("uses deterministic encoded paths and requires an explicit identity", () => {
    expect(reportPath({ packageName: "@t3tools/web", event: "test:browser" })).toBe(
      join("%40t3tools%2Fweb", "test%3Abrowser", "results.json"),
    );
    expect(ciTestReports({})).toEqual({});
    expect(() => ciTestReports({ F5_CI_REPORT_DIR: "reports" })).toThrow("CI reports require");
    expect(
      ciTestReports({ F5_CI_REPORT_DIR: "reports", F5_CI_SUITE_ID: "server-unit-1" }).outputFile,
    ).toMatchObject({
      json: expect.stringContaining(join("suites", "server-unit-1", "results.json")),
    });
  });
  it("retries once in CI only, records flaky passes, and honours the retry override", () => {
    const env = { F5_CI_REPORT_DIR: "reports", F5_CI_SUITE_ID: "server-unit-1" };
    const config = ciTestReports(env);
    expect(config.retry).toBe(1);
    expect(config.reporters).toEqual(
      expect.arrayContaining(["default", "junit", "json", expect.any(CiFlakyReporter)]),
    );
    expect(ciTestReports({ ...env, F5_CI_TEST_RETRY: "0" }).retry).toBe(0);
    expect(ciTestRetry({})).toBe(1);
    for (const invalid of ["-1", "1.5", "x", "4"])
      expect(() => ciTestRetry({ F5_CI_TEST_RETRY: invalid })).toThrow("F5_CI_TEST_RETRY");
  });
  it("records exactly the tests that passed on retry", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-flaky-reporter-"));
    directories.push(directory);
    const records = join(directory, "out", FLAKY_RECORD_FILE);
    const reporter = pathToFileURL(resolve(import.meta.dirname, "lib/ci-test-reports.ts")).href;
    // Globals keep the fixture free of a `vitest` import it could not resolve from tmp.
    writeFileSync(
      join(directory, "vitest.config.mjs"),
      `import { CiFlakyReporter } from ${JSON.stringify(reporter)};
export default { test: { globals: true, retry: 1, include: ["*.test.mjs"],
  reporters: ["default", new CiFlakyReporter(${JSON.stringify(records)}, "fixture/test")] } };`,
    );
    writeFileSync(
      join(directory, "fixture.test.mjs"),
      `import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(join(directory, "attempted"))};
describe("group", () => {
  test("fails once", () => {
    if (!existsSync(marker)) { writeFileSync(marker, ""); throw new Error("first attempt <b>"); }
  });
  test("always passes", () => {});
});`,
    );
    const passing = runFixture(directory);
    expect(passing.status, passing.output).toBe(0);
    expect(readFlakyRecords(join(directory, "out"))).toEqual([
      expect.objectContaining({
        version: 1,
        kind: "test",
        suite: "fixture/test",
        file: expect.stringMatching(/^(\.\.\/)+.*\/fixture\.test\.mjs$/),
        name: "group > fails once",
        retryCount: 1,
        errors: ["first attempt <b>"],
      }),
    ]);
    rmSync(records);
    writeFileSync(
      join(directory, "fixture.test.mjs"),
      `test("always fails", () => { throw new Error("broken"); });`,
    );
    expect(runFixture(directory).status).not.toBe(0);
    expect(readFlakyRecords(join(directory, "out"))).toEqual([]);
  }, 60_000);
  it("renders flaky passes without treating their records as suite reports", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-flaky-summary-"));
    directories.push(directory);
    const expected = [{ packageName: "package", event: "test" }];
    const file = join(directory, reportPath(expected[0]!));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(fixture()));
    const record = flakyRecord({
      kind: "test",
      suite: "package/test",
      file: "a.test.ts",
      name: "group | <b>x</b>\nnext, 100%",
      retryCount: 1,
      errors: [],
    });
    appendFlakyRecords(join(dirname(file), FLAKY_RECORD_FILE), [
      record,
      { ...record, kind: "step", name: "desktop-smoke" },
    ]);
    expect(summarize(directory, expected).map((result) => result.verdict)).toEqual(["passed"]);
    const { markdown, annotations } = renderFlaky(readFlakyRecords(directory));
    expect(markdown).toContain("Passed on retry (flaky)");
    expect(markdown).toContain(
      "| test | a.test.ts &gt; group   &lt;b&gt;x&lt;/b&gt; next, 100% | 1 |",
    );
    expect(markdown).toContain("| step | a.test.ts &gt; desktop-smoke |");
    expect(annotations).toEqual([
      "::warning title=Flaky test::package/test a.test.ts > group | <b>x</b>%0Anext, 100%25",
    ]);
    expect(renderFlaky([])).toEqual({ markdown: "", annotations: [] });
  });
  it("ignores malformed flaky records", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-flaky-malformed-"));
    directories.push(directory);
    writeFileSync(
      join(directory, FLAKY_RECORD_FILE),
      ["{", "null", JSON.stringify({ version: 2 }), ""].join("\n"),
    );
    expect(readFlakyRecords(directory)).toEqual([]);
  });
  it("classifies executed, failed, skipped and unfinished suites", () => {
    expect(classifyReport(fixture(), "suite").verdict).toBe("passed");
    expect(classifyReport({ ...fixture(), success: false }, "suite").verdict).toBe("failed");
    const skipped = fixture();
    skipped.numPassedTests = 0;
    skipped.numPendingTests = 1;
    skipped.testResults[0]!.assertionResults[0]!.status = "skipped";
    expect(classifyReport(skipped, "suite").verdict).toBe("skipped");
    expect(classifyReport({ ...fixture(), numTotalTests: 2 }, "suite").verdict).toBe("incomplete");
    const duplicate = fixture();
    duplicate.testResults.push(duplicate.testResults[0]!);
    expect(classifyReport(duplicate, "suite").verdict).toBe("incomplete");
  });
  it("rejects unfinished assertions even when another assertion passed", () => {
    const unfinished = fixture();
    unfinished.numPendingTests = 1;
    unfinished.numTotalTests = 2;
    unfinished.testResults[0]!.assertionResults.push({ status: "pending" });
    expect(classifyReport(unfinished, "suite")).toMatchObject({
      verdict: "incomplete",
      detail: "Unfinished test",
    });
  });
  it("rejects pending suites even when all reported assertions passed", () => {
    expect(classifyReport({ ...fixture(), numPendingTestSuites: 1 }, "suite")).toMatchObject({
      verdict: "incomplete",
      detail: "Unfinished test suite",
    });
  });
  it("keeps intentional skips and todos visible alongside executed tests", () => {
    const report = fixture();
    report.numPendingTests = 1;
    report.numTodoTests = 1;
    report.numTotalTests = 3;
    report.testResults[0]!.assertionResults.push({ status: "skipped" }, { status: "todo" });
    expect(classifyReport(report, "suite")).toMatchObject({
      verdict: "passed",
      passed: 1,
      skipped: 2,
    });
  });
  it("rejects deleted, malformed, truncated, duplicate and unexpected reports", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-report-test-"));
    directories.push(directory);
    const expected = [{ packageName: "package", event: "test" }];
    const file = join(directory, reportPath(expected[0]!));
    mkdirSync(dirname(file), { recursive: true });
    expect(summarize(directory, expected)[0]!.verdict).toBe("incomplete");
    for (const content of ["{", "null", JSON.stringify({ ...fixture(), numTotalTests: 99 })]) {
      writeFileSync(file, content);
      expect(summarize(directory, expected)[0]!.verdict).toBe("incomplete");
    }
    writeFileSync(file, JSON.stringify(fixture()));
    expect(summarize(directory, expected)[0]!.verdict).toBe("passed");
    writeFileSync(join(directory, "extra.json"), JSON.stringify(fixture()));
    expect(
      summarize(directory, expected).some((result) => result.detail.includes("Unexpected")),
    ).toBe(true);
  });
});
