import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture } from "./fixtures.ts";

export interface Samples {
  wallMs: number[];
  cpuMs: number[];
}
export interface Observation {
  name: string;
  actual: number;
  maximum: number;
  passed: boolean;
}
export interface PerformanceReport {
  schemaVersion: 1;
  scope: "server-component";
  mode: "smoke" | "measurement";
  metadata: ReturnType<typeof metadata>;
  method: { warmups: number; repetitions: number };
  measurements: Record<string, Samples>;
  observations: Observation[];
  notMeasured: string[];
}

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function metadata(root: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const fixtureSources = ["fixtures.json", "fixtures.ts"].map((file) =>
    readFileSync(path.join(root, "scripts/lib/performance", file), "utf8"),
  );
  return {
    capturedAt: new Date().toISOString(),
    sourceCommit: git(["rev-parse", "HEAD"]),
    gitVersion: git(["--version"]),
    sourceDirty: git(["status", "--porcelain"]).length > 0,
    fixtureDigest: hash(JSON.stringify(fixtureSources)),
    harnessDigest: hash(
      JSON.stringify(
        [
          "scripts/lib/performance/report.ts",
          "apps/server/scripts/performance/server.perf.ts",
          "apps/server/scripts/performance/sqlite-writer.mjs",
          "apps/server/vitest.performance.config.ts",
        ].map((file) => readFileSync(path.join(root, file), "utf8")),
      ),
    ),
    dependencyLockDigest: hash(readFileSync(path.join(root, "bun.lock"))),
    runtime: { executable: process.execPath, versions: process.versions },
    browser: null,
    os: { platform: os.platform(), release: os.release(), architecture: os.arch() },
    hardware: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      memoryBytes: os.totalmem(),
    },
    dependencies: Object.fromEntries(
      ["apps/server", "packages/contracts", "packages/shared"].map((dir) => {
        const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
        return [
          pkg.name,
          {
            version: pkg.version,
            dependencies: Object.fromEntries(
              Object.keys(pkg.dependencies ?? {}).map((name) => {
                const installed = JSON.parse(
                  readFileSync(path.join(root, dir, "node_modules", name, "package.json"), "utf8"),
                );
                return [name, installed.version];
              }),
            ),
          },
        ];
      }),
    ),
  };
}

export function percentile95(samples: ReadonlyArray<number>): number {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Expected nonempty finite, nonnegative measurements");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export async function measure(
  operation: () => Promise<void>,
  method = fixture.method,
  prepare?: () => Promise<void>,
): Promise<Samples> {
  const result: Samples = { wallMs: [], cpuMs: [] };
  for (let i = -method.warmups; i < method.repetitions; i++) {
    await prepare?.();
    const cpu = process.cpuUsage();
    const start = performance.now();
    await operation();
    const elapsed = performance.now() - start;
    const used = process.cpuUsage(cpu);
    if (i >= 0) {
      result.wallMs.push(elapsed);
      result.cpuMs.push((used.user + used.system) / 1000);
    }
  }
  return result;
}

export function maximumObservation(name: string, actual: number, maximum: number): Observation {
  if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(maximum) || maximum < 0)
    throw new Error(`Invalid observation: ${name}`);
  return { name, actual, maximum, passed: actual <= maximum };
}

/** The regression rule requires BOTH 10% and 20ms; targeted CPU work must improve 20%. */
export function comparisonGate(baseline: number, candidate: number, targetCpu = false): boolean {
  if (![baseline, candidate].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("Invalid comparison measurements");
  return targetCpu
    ? candidate <= baseline * 0.8
    : !(candidate > baseline * 1.1 && candidate - baseline > 20);
}

/** Never accept a smoke run, missing scenario, different fixture, or incompatible machine. */
export function compareReports(
  base: PerformanceReport,
  next: PerformanceReport,
  cpuTargets: string[] = [],
): string[] {
  const failures: string[] = [];
  for (const report of [base, next]) {
    if (
      report.schemaVersion !== 1 ||
      report.scope !== "server-component" ||
      report.mode !== "measurement" ||
      report.method.warmups !== 5 ||
      report.method.repetitions !== 30
    )
      failures.push("Comparison requires full server measurements (5 warmups, 30 repetitions)");
  }
  for (const key of ["fixtureDigest", "harnessDigest", "hardware", "os", "gitVersion"] as const)
    if (JSON.stringify(base.metadata[key]) !== JSON.stringify(next.metadata[key]))
      failures.push(`Incompatible ${key}`);
  if (
    base.metadata.runtime.versions.node !== next.metadata.runtime.versions.node ||
    base.metadata.runtime.versions.bun !== next.metadata.runtime.versions.bun
  )
    failures.push("Incompatible runtime versions");
  const names = Object.keys(base.measurements);
  if (
    names.length === 0 ||
    JSON.stringify([...names].sort()) !== JSON.stringify(Object.keys(next.measurements).sort())
  )
    failures.push("Measurement coverage differs or is empty");
  for (const target of cpuTargets)
    if (!names.includes(target)) failures.push(`Unknown CPU target: ${target}`);
  const bounds = (report: PerformanceReport) =>
    report.observations
      .map(({ name, maximum }) => ({ name, maximum }))
      .sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(bounds(base)) !== JSON.stringify(bounds(next)))
    failures.push("Resource bounds changed or disappeared");
  for (const name of names) {
    const previous = base.measurements[name]!;
    const current = next.measurements[name];
    if (!current) continue;
    if (
      [previous.wallMs, previous.cpuMs, current.wallMs, current.cpuMs].some(
        (samples) => samples.length !== 30 || samples.some((n) => !Number.isFinite(n) || n < 0),
      )
    ) {
      failures.push(`Incomplete samples: ${name}`);
      continue;
    }
    if (!comparisonGate(percentile95(previous.wallMs), percentile95(current.wallMs)))
      failures.push(`Latency regression: ${name}`);
    if (
      cpuTargets.includes(name) &&
      !comparisonGate(percentile95(previous.cpuMs), percentile95(current.cpuMs), true)
    )
      failures.push(`CPU improvement below 20%: ${name}`);
  }
  for (const observation of next.observations)
    if (
      !maximumObservation(observation.name, observation.actual, observation.maximum).passed ||
      !observation.passed
    )
      failures.push(`Exceeded bound: ${observation.name}`);
  return failures;
}
