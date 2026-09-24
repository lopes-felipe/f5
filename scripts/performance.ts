import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareReports, percentile95, type PerformanceReport } from "./lib/performance/report.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "compare") {
  if (args.length < 3)
    throw new Error(
      "Usage: bun scripts/performance.ts compare <base.json> <candidate.json> [CPU target names...]",
    );
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PerformanceReport;
  const failures = compareReports(read(args[1]!), read(args[2]!), args.slice(3));
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
  else
    console.log(
      "Measured server component gates pass. This does not certify unmeasured browser, transport or memory gates.",
    );
} else {
  if (args.some((arg) => arg !== "--smoke" && !arg.startsWith("--output=")))
    throw new Error("Usage: bun run perf:server [--smoke] [--output=<new-report.json>]");
  const smoke = args.includes("--smoke");
  const output = path.resolve(
    root,
    args.find((a) => a.startsWith("--output="))?.slice(9) ??
      `.performance/server-${Date.now()}.json`,
  );
  if (existsSync(output)) throw new Error(`Refusing to overwrite report: ${output}`);
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
      env: { ...process.env, F5_PERF_REPORT: output, F5_PERF_SMOKE: smoke ? "1" : "0" },
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
