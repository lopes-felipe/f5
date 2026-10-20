import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ciTestReports, reportPath } from "./lib/ci-test-reports.ts";
import { classifyReport, summarize } from "./ci-test-summary.ts";

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
  it("requires exactly one passed archive integration and zero skips", () => {
    const directory = mkdtempSync(join(tmpdir(), "f5-archive-report-test-"));
    directories.push(directory);
    const expected = [{ packageName: "suites", event: "archive-integration" }];
    const file = join(directory, reportPath(expected[0]!));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(fixture()));
    expect(summarize(directory, expected)[0]!.verdict).toBe("passed");
    for (const status of ["passed", "skipped"]) {
      const report = fixture();
      report.numTotalTests++;
      if (status === "passed") report.numPassedTests++;
      else report.numPendingTests++;
      report.testResults[0]!.assertionResults.push({ status });
      writeFileSync(file, JSON.stringify(report));
      expect(summarize(directory, expected)[0]!.verdict).toBe("incomplete");
    }
  });
});
