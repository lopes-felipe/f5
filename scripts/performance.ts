import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareReports, percentile95, type PerformanceReport } from "./lib/performance/report.ts";

import { validateCoverage } from "./lib/performance/coverage.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "coverage") {
  if (args.length !== 3)
    throw new Error("Usage: bun scripts/performance.ts coverage <server.json> <interactive.json>");
  const reports = args
    .slice(1)
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as PerformanceReport);
  const errors = validateCoverage(reports);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else {
    console.log(
      "Complete Phase 0d measurement coverage (5 warmups, 30 repetitions, 10-minute soak).",
    );
    for (const report of reports)
      for (const observation of report.observations)
        if (!observation.passed) console.log(`Measured gate failure: ${observation.name}`);
  }
} else if (args[0] === "compare") {
  if (args.length < 3)
    throw new Error(
      "Usage: bun scripts/performance.ts compare <base.json> <candidate.json> [CPU target names...]",
    );
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PerformanceReport;
  const failures = compareReports(read(args[1]!), read(args[2]!), args.slice(3));
  for (const failure of new Set(failures)) console.error(failure);
  if (failures.length) process.exitCode = 1;
  else
    console.log(
      "Measured report gates pass. Both server-component and interactive reports are required for complete coverage.",
    );
} else {
  const interactive = args[0] === "interactive";
  if (interactive) args.shift();
  if (args.some((arg) => arg !== "--smoke" && !arg.startsWith("--output=")))
    throw new Error(
      "Usage: bun scripts/performance.ts [interactive] [--smoke] [--output=<new-report.json>]",
    );
  const smoke = args.includes("--smoke");
  const output = path.resolve(
    root,
    args.find((a) => a.startsWith("--output="))?.slice(9) ??
      `.performance/${interactive ? "interactive" : "server"}-${Date.now()}.json`,
  );
  for (const file of [output, `${output}.browser.json`, `${output}.browser.json.progress`])
    if (existsSync(file)) throw new Error(`Refusing to overwrite report: ${file}`);
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(
    "node",
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.performance.config.ts",
    ],
    {
      cwd: path.join(root, "apps/server"),
      stdio: "inherit",
      env: {
        ...process.env,
        F5_PERF_REPORT: output,
        F5_PERF_SMOKE: smoke ? "1" : "0",
        F5_PERF_INTERACTIVE: interactive ? "1" : "0",
        F5_PERF_MEMORY_MINUTES: interactive && !smoke ? "10" : "0",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const report = JSON.parse(readFileSync(output, "utf8")) as PerformanceReport;
    console.log(
      `Report: ${output} (${report.mode}; ${report.method.repetitions} measured repetitions)`,
    );
    for (const [name, samples] of Object.entries(report.measurements))
      console.log(
        `${name}: wall p95 ${percentile95(samples.wallMs).toFixed(2)} ms, process CPU p95 ${percentile95(samples.cpuMs).toFixed(2)} ms`,
      );
    for (const observation of report.observations)
      console.log(
        `${observation.passed ? "PASS" : "FAIL"} ${observation.name}: ${observation.actual} / ${observation.maximum}`,
      );
    console.log(`Not measured: ${report.notMeasured.join("; ")}`);
  }
}
