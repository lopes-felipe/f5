import { classifyReport } from "./ci-test-report-validation.ts";
import type { TestDurations } from "./ci-test-sharding.ts";

export function serverTestPath(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  const marker = "/apps/server/";
  const index = normalized.lastIndexOf(marker);
  const relative = index < 0 ? normalized : normalized.slice(index + marker.length);
  if (!/^src\/.+\.test\.[cm]?[jt]sx?$/.test(relative) || relative.split("/").includes(".."))
    throw new Error("Expected a server src test path");
  return relative;
}

export function collectTestDurations(
  reports: readonly unknown[],
  expectedFiles: readonly string[],
): TestDurations {
  if (!reports.length) throw new Error("Missing server unit reports");
  const durations: Record<string, number> = {};
  for (const report of reports) {
    if (classifyReport(report, "server-unit").verdict !== "passed")
      throw new Error("Cannot refresh timings from an unsuccessful or incomplete report");
    const files = (
      report as { testResults: { name: string; startTime: number; endTime: number }[] }
    ).testResults;
    for (const file of files) {
      const key = serverTestPath(file.name);
      if (Object.hasOwn(durations, key)) throw new Error("Duplicate server test report");
      durations[key] = Math.max(1, file.endTime - file.startTime);
    }
  }
  const actual = Object.keys(durations).sort();
  if (
    new Set(expectedFiles).size !== expectedFiles.length ||
    JSON.stringify(actual) !== JSON.stringify([...expectedFiles].sort())
  )
    throw new Error("Report inventory differs from the current server test inventory");
  return Object.fromEntries(actual.map((file) => [file, durations[file]!]));
}
