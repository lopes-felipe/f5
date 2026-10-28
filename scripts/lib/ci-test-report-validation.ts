import { relative } from "node:path";

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
