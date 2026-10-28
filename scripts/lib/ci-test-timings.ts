import { classifyReport } from "./ci-test-report-validation.ts";
import { median, type TestDurations } from "./ci-test-sharding.ts";

export function medianDurations(samples: readonly TestDurations[]): TestDurations {
  if (samples.length < 3) throw new Error("At least three independent main runs are required");
  const files = Object.keys(samples[0]!).sort();
  for (const sample of samples) {
    if (JSON.stringify(Object.keys(sample).sort()) !== JSON.stringify(files))
      throw new Error("Timing sample inventories differ");
    if (Object.values(sample).some((value) => !Number.isFinite(value) || value <= 0))
      throw new Error("Invalid timing duration");
  }
  return Object.fromEntries(
    files.map((file) => [file, median(samples.map((sample) => sample[file]!))]),
  );
}

export function collectSchedulingDurations(
  reports: readonly unknown[],
  timings: readonly unknown[],
  expected: readonly string[],
): TestDurations {
  collectTestDurations(reports, expected);
  const values: Record<string, number> = {};
  for (const timing of timings) {
    const data = timing as { version: number; durationsMs: Record<string, number> };
    if (data.version !== 1 || !data.durationsMs) throw new Error("Invalid scheduling report");
    for (const [path, value] of Object.entries(data.durationsMs)) {
      const key = serverTestPath(path);
      if (Object.hasOwn(values, key)) throw new Error("Duplicate scheduling duration");
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid scheduling duration");
      values[key] = value;
    }
  }
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify([...expected].sort()))
    throw new Error(
      "Missing scheduling metrics: source runs must contain the import-aware reporter and current test inventory",
    );
  return values;
}

export function reportArtifact(name: string) {
  const match = /^reports-(server-unit-Linux|windows-server-unit-Windows)-(\d+)-([1-9]\d*)$/.exec(
    name,
  );
  if (!match) throw new Error("Unknown server report artifact: " + name);
  const platform = match[1] === "server-unit-Linux" ? "linux" : "win32";
  return {
    platform,
    job:
      (platform === "linux" ? "server-unit" : "windows-server-unit") +
      " (" +
      (Number(match[2]) + 1) +
      ")",
    attempt: Number(match[3]),
  };
}

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
