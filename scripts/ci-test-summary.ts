import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reportPath, type SuiteIdentity } from "./lib/ci-test-reports.ts";

const workspaces: SuiteIdentity[] = [
  "@t3tools/contracts",
  "@t3tools/shared",
  "effect-acp",
  "@t3tools/scripts",
  "@t3tools/web",
  "@t3tools/desktop",
  "@t3tools/marketing",
].map((packageName) => ({ packageName, event: "test" }));
const suite = (event: string): SuiteIdentity => ({ packageName: "suites", event });
const server = ["server-git-smoke", "server-integration"].map(suite);
export const inventories: Record<string, SuiteIdentity[]> = {
  test: [...workspaces, ...server, suite("server-git-extended")],
  "windows-build": [...workspaces, ...server],
  "macos-suite": [...workspaces, ...server, suite("server-git-extended"), suite("server-unit")],
  "server-unit-1": [suite("server-unit-1")],
  "server-unit-2": [suite("server-unit-2")],
  browser: [suite("web-browser")],
  "macos-profiles": [suite("macos-profiles")],
  "archive-integration": [suite("archive-integration")],
};

export type Verdict = "passed" | "failed" | "skipped" | "incomplete";
export interface SuiteSummary {
  name: string;
  verdict: Verdict;
  passed: number;
  failed: number;
  skipped: number;
  detail: string;
}

// Validate structure and accounting rather than trusting the producer's success flag.
export function classifyReport(value: unknown, name: string): SuiteSummary {
  const incomplete = (detail: string): SuiteSummary => ({
    name,
    verdict: "incomplete",
    passed: 0,
    failed: 0,
    skipped: 0,
    detail,
  });
  if (!value || typeof value !== "object") return incomplete("Malformed report");
  const report = value as Record<string, unknown>;
  const counts = [
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numTotalTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ];
  if (
    counts.some((key) => !Number.isSafeInteger(report[key]) || (report[key] as number) < 0) ||
    typeof report.success !== "boolean" ||
    !Array.isArray(report.testResults) ||
    !report.testResults.length ||
    typeof report.startTime !== "number" ||
    report.startTime <= 0
  )
    return incomplete("Missing report fields");
  if (report.numPendingTestSuites !== 0) return incomplete("Unfinished test suite");
  const seen = new Set<string>();
  let fileFailure = false;
  let passed = 0,
    failed = 0,
    skipped = 0;
  for (const file of report.testResults) {
    if (
      !file ||
      typeof file.name !== "string" ||
      seen.has(file.name) ||
      !["passed", "failed"].includes(file.status) ||
      !Array.isArray(file.assertionResults) ||
      !Number.isFinite(file.startTime) ||
      !Number.isFinite(file.endTime) ||
      file.endTime < file.startTime
    )
      return incomplete("Malformed or duplicate test file");
    seen.add(file.name);
    if (file.status === "failed") fileFailure = true;
    for (const test of file.assertionResults) {
      if (!test || typeof test !== "object") return incomplete("Malformed test");
      if (test.status === "passed") passed++;
      else if (test.status === "failed") failed++;
      else if (["skipped", "todo", "disabled"].includes(test.status)) skipped++;
      else return incomplete("Unfinished test");
    }
  }
  if (
    passed !== report.numPassedTests ||
    failed !== report.numFailedTests ||
    skipped !== (report.numPendingTests as number) + (report.numTodoTests as number) ||
    passed + failed + skipped !== report.numTotalTests
  )
    return incomplete("Truncated or inconsistent test counts");
  if (report.success && !fileFailure && report.numFailedTestSuites === 0 && !passed && !failed)
    return { name, verdict: "skipped", passed, failed, skipped, detail: "No executed tests" };
  const verdict =
    !report.success || failed || fileFailure || (report.numFailedTestSuites as number) > 0
      ? "failed"
      : "passed";
  const skippedFiles = report.testResults
    .filter(
      (file) =>
        file.assertionResults.length &&
        file.assertionResults.every(
          (test: { status: string }) => test.status !== "passed" && test.status !== "failed",
        ),
    )
    .map((file) => relative(process.cwd(), file.name));
  return {
    name,
    verdict,
    passed,
    failed,
    skipped,
    detail: skippedFiles.length ? `Skipped files: ${skippedFiles.join(", ")}` : "",
  };
}

export function summarize(directory: string, expected: SuiteIdentity[]): SuiteSummary[] {
  const reports: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".json")) reports.push(relative(directory, file));
    }
  }
  try {
    walk(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedPaths = new Set(expected.map(reportPath));
  const results = expected.map((identity) => {
    const file = reportPath(identity);
    try {
      const result = classifyReport(
        JSON.parse(readFileSync(join(directory, file), "utf8")),
        `${identity.packageName}/${identity.event}`,
      );
      if (
        identity.packageName === "suites" &&
        identity.event === "archive-integration" &&
        result.verdict === "passed" &&
        (result.passed !== 1 || result.skipped !== 0)
      )
        return {
          ...result,
          verdict: "incomplete" as const,
          detail: "Archive integration requires exactly one passed test and zero skips",
        };
      return result;
    } catch {
      return {
        name: file,
        verdict: "incomplete" as const,
        passed: 0,
        failed: 0,
        skipped: 0,
        detail: "Missing or malformed JSON",
      };
    }
  });
  for (const file of reports)
    if (!expectedPaths.has(file))
      results.push({
        name: file,
        verdict: "incomplete",
        passed: 0,
        failed: 0,
        skipped: 0,
        detail: "Unexpected or duplicate report",
      });
  return results;
}

function main() {
  const directory = process.env.F5_CI_REPORT_DIR;
  if (!directory) throw new Error("F5_CI_REPORT_DIR is required");
  if (process.argv[2] === "--prepare") {
    // Only this job's runner-temp directory may be cleared, never another job's reports.
    const runnerTemp = process.env.RUNNER_TEMP;
    if (
      !runnerTemp ||
      (!resolve(directory).startsWith(resolve(runnerTemp) + "/") &&
        !resolve(directory).startsWith(resolve(runnerTemp) + "\\"))
    )
      throw new Error("Reports must be below RUNNER_TEMP");
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    return;
  }
  const expected = inventories[process.argv[2] ?? ""];
  if (!expected?.length) throw new Error("Unknown or empty suite inventory");
  const results = summarize(directory, expected);
  const escape = (text: string) => text.replace(/[|\r\n]/g, " ");
  const markdown =
    "\n| Suite | Result | Passed | Failed | Skipped | Detail |\n| --- | --- | ---: | ---: | ---: | --- |\n" +
    results
      .map(
        (result) =>
          `| ${escape(result.name)} | ${result.verdict} | ${result.passed} | ${result.failed} | ${result.skipped} | ${escape(result.detail)} |`,
      )
      .join("\n") +
    "\n";
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    mkdirSync(dirname(process.env.GITHUB_STEP_SUMMARY), { recursive: true });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  if (results.some((result) => result.verdict !== "passed")) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
