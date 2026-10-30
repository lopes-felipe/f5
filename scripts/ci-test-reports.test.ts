import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectOccurrences } from "./ci-flake-ledger.ts";
import {
  appendFlakyRecords,
  FAILURE_RECORD_FILE,
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
/** A fixture project using the real CI reporters, as `ciTestReports()` would configure them. */
const writeFixture = (root: string) => {
  const reports = pathToFileURL(resolve(import.meta.dirname, "lib/ci-test-reports.ts")).href;
  // Globals keep the fixture free of a `vitest` import it could not resolve from tmp.
  writeFileSync(
    join(root, "vitest.config.mjs"),
    `import { ciTestReports } from ${JSON.stringify(reports)};
const reports = ciTestReports();
export default { test: { ...reports, globals: true, include: ["*.test.mjs"],
  reporters: reports.reporters.filter((reporter) => reporter !== "junit") } };`,
  );
};
const runFixture = (root: string, reportDir: string, retry: number) => {
  const result = spawnSync(
    process.execPath,
    [vitestCli, "run", "--root", root, "--config", join(root, "vitest.config.mjs")],
    {
      encoding: "utf8",
      // Only the identity under test: nothing from this run's own CI environment.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        F5_CI_REPORT_DIR: reportDir,
        F5_CI_SUITE_ID: "",
        F5_CI_TEST_RETRY: String(retry),
        npm_package_name: "fixture",
        npm_lifecycle_event: "test",
      },
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
  it("records exactly the tests that passed on retry, under the ledger's rerun identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-flaky-reporter-"));
    directories.push(directory);
    const suite = { packageName: "fixture", event: "test" };
    const fixtureFile = join(directory, "fixture.test.mjs");
    const marker = join(directory, "attempted");
    writeFixture(directory);
    writeFileSync(
      fixtureFile,
      `import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
describe("group", () => {
  test("fails once", () => {
    if (!existsSync(marker)) { writeFileSync(marker, ""); throw new Error("first attempt <b>"); }
  });
  test("always passes", () => {});
});`,
    );
    // Attempt 1 has no retry and fails, as before a manual rerun; attempt 2 retries.
    const firstAttempt = join(directory, "artifacts", "reports-test-Linux-0-1");
    expect(runFixture(directory, firstAttempt, 0).status).not.toBe(0);
    rmSync(marker);
    const secondAttempt = join(directory, "artifacts", "reports-test-Linux-0-2");
    const passing = runFixture(directory, secondAttempt, 1);
    expect(passing.status, passing.output).toBe(0);
    expect(readFlakyRecords(firstAttempt)).toEqual([]);
    expect(readFlakyRecords(secondAttempt)).toEqual([
      expect.objectContaining({
        version: 1,
        kind: "test",
        suite: "fixture/test",
        file: fixtureFile.replaceAll("\\", "/"),
        name: "group > fails once",
        retryCount: 1,
        errors: ["first attempt <b>"],
      }),
    ]);
    expect(readFileSync(join(secondAttempt, reportPath(suite)), "utf8")).toContain("passed");
    // Real Vitest output from both sources must land on one ledger issue.
    const occurrences = collectOccurrences(join(directory, "artifacts"), {
      runId: "1",
      runAttempt: 2,
      conclusion: "success",
      branch: "main",
      sha: "",
      runUrl: "",
      repoName: "f5",
      event: "push",
      defaultBranch: "main",
    });
    expect(occurrences.map((occurrence) => occurrence.kind).sort()).toEqual(["rerun", "test"]);
    expect(new Set(occurrences.map((occurrence) => occurrence.id)).size).toBe(1);
  }, 60_000);
  it("records an unhandled error, which Vitest's JSON report does not count as a failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-unhandled-reporter-"));
    directories.push(directory);
    writeFixture(directory);
    writeFileSync(
      join(directory, "fixture.test.mjs"),
      `test("passes but leaks an error", async () => {
  setTimeout(() => { throw new Error("late failure"); }, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
});`,
    );
    const out = join(directory, "out");
    expect(runFixture(directory, out, 1).status).not.toBe(0);
    expect(readFlakyRecords(out)).toEqual([]);
    expect(readFlakyRecords(out, FAILURE_RECORD_FILE)).toEqual([
      expect.objectContaining({
        kind: "unhandled",
        suite: "fixture/test",
        errors: [expect.stringContaining("late failure")],
      }),
    ]);
  }, 60_000);
  it("records nothing for a test that fails every attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-failing-reporter-"));
    directories.push(directory);
    writeFixture(directory);
    writeFileSync(
      join(directory, "fixture.test.mjs"),
      `test("always fails", () => { throw new Error("broken"); });`,
    );
    const out = join(directory, "out");
    expect(runFixture(directory, out, 1).status).not.toBe(0);
    expect(readFlakyRecords(out)).toEqual([]);
    expect(readFlakyRecords(out, FAILURE_RECORD_FILE)).toEqual([]);
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
