import { expect, it } from "vitest";
import { nightlyBaselineDecision, selectNightlyBaselineArtifact } from "./performance-nightly.ts";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { PerformanceReport } from "./lib/performance/report.ts";
function report(): PerformanceReport {
  return {
    schemaVersion: 1,
    scope: "server-component",
    mode: "measurement",
    metadata: {
      fixtureDigest: "fixture",
      harnessDigest: "harness",
      hardware: {},
      os: {},
      runtime: { versions: { node: "24.13.1", bun: "1.3.9" } },
    } as PerformanceReport["metadata"],
    method: { warmups: 5, repetitions: 30 },
    measurements: { sample: { wallMs: Array(30).fill(1), cpuMs: Array(30).fill(1) } },
    observations: [],
    notMeasured: ["browser"],
  };
}
it("initializes, resets or re-baselines incompatible metadata and compares compatible reports", () => {
  expect(nightlyBaselineDecision(report()).replace).toBe(true);
  expect(nightlyBaselineDecision(report(), report(), true).replace).toBe(true);
  expect(nightlyBaselineDecision(report(), report()).replace).toBe(false);
  for (const key of [
    "fixtureDigest",
    "harnessDigest",
    "hardware",
    "os",
    "gitVersion",
    "browser",
    "browserConfig",
  ] as const) {
    const candidate = report();
    Object.assign(candidate.metadata, { [key]: "changed" });
    expect(nightlyBaselineDecision(candidate, report())).toMatchObject({
      replace: true,
      reason: expect.stringContaining("incompatible"),
    });
  }
  const candidate = report();
  candidate.metadata.runtime.versions.node = "changed";
  expect(nightlyBaselineDecision(candidate, report()).replace).toBe(true);
  expect(() => nightlyBaselineDecision({ ...report(), mode: "smoke" })).toThrow(
    "full server measurements",
  );
});

it("selects only retained artifacts from successful own-repository main nightly runs", () => {
  const run = {
    id: 1,
    workflow_id: 10,
    head_repository: { id: 20 },
    head_branch: "main",
    event: "schedule",
    conclusion: "success",
  };
  const artifact = {
    id: 100,
    name: "perf-baseline",
    expired: false,
    created_at: "2026-10-19T00:00:00Z",
    workflow_run: { id: 1, head_repository_id: 20 },
  };
  const choose = (runs = [run], artifacts = [artifact]) =>
    selectNightlyBaselineArtifact({ workflowId: 10, repositoryId: 20, runs, artifacts });
  expect(choose()).toBe(100);
  for (const change of [
    { workflow_id: 11 },
    { head_repository: { id: 21 } },
    { head_branch: "feature" },
    { event: "pull_request" },
    { conclusion: "failure" },
  ])
    expect(choose([{ ...run, ...change }])).toBeUndefined();
  for (const change of [
    { expired: true },
    { name: "perf-candidate" },
    { workflow_run: { id: 2, head_repository_id: 20 } },
    { workflow_run: { id: 1, head_repository_id: 21 } },
  ])
    expect(choose([run], [{ ...artifact, ...change }])).toBeUndefined();
  expect(
    choose(
      [run, { ...run, id: 2, event: "workflow_dispatch" }],
      [
        artifact,
        {
          ...artifact,
          id: 101,
          created_at: "2026-10-20T00:00:00Z",
          workflow_run: { id: 2, head_repository_id: 20 },
        },
      ],
    ),
  ).toBe(101);
});

it.each(["pass", "regression", "initialize", "incompatible"] as const)(
  "%s retains only the correct successful comparison anchor",
  (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "f5-nightly-retention-"));
    const candidatePath = join(directory, "candidate.json"),
      baselinePath = join(directory, "baseline.json");
    const retainedPath = join(directory, "retained", "candidate.json"),
      outputPath = join(directory, "output.txt");
    try {
      const baseline = report(),
        candidate = report();
      if (mode === "incompatible")
        candidate.metadata = {
          ...candidate.metadata,
          runtime: {
            ...candidate.metadata.runtime,
            versions: { ...candidate.metadata.runtime.versions, node: "different-runtime" },
          },
        };
      candidate.measurements.sample!.wallMs = Array(30).fill(mode === "regression" ? 100 : 1.01);
      writeFileSync(candidatePath, JSON.stringify(candidate));
      if (mode !== "initialize") writeFileSync(baselinePath, JSON.stringify(baseline));
      writeFileSync(outputPath, "");
      const result = spawnSync(
        "bun",
        [
          fileURLToPath(new URL("./performance-nightly.ts", import.meta.url)),
          candidatePath,
          baselinePath,
          retainedPath,
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          encoding: "utf8",
          env: {
            ...process.env,
            RESET_BASELINE: "false",
            GITHUB_OUTPUT: outputPath,
            GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(mode === "regression" ? 1 : 0);
      if (mode === "incompatible") {
        expect(result.stdout).toContain("::warning::Baseline incompatible");
        expect(readFileSync(join(directory, "summary.md"), "utf8")).toContain(
          "no performance comparison was made",
        );
        expect(JSON.parse(readFileSync(baselinePath, "utf8"))).toEqual(baseline);
      }
      if (mode === "initialize") {
        expect(result.stdout).toContain("::warning::No retained baseline");
        expect(readFileSync(join(directory, "summary.md"), "utf8")).toContain("artifact expiry");
      }
      if (mode === "regression") {
        expect(existsSync(retainedPath)).toBe(false);
        expect(readFileSync(outputPath, "utf8")).not.toContain("retain-baseline=true");
      } else {
        expect(JSON.parse(readFileSync(retainedPath, "utf8"))).toEqual(
          mode === "initialize" || mode === "incompatible" ? candidate : baseline,
        );
        expect(readFileSync(outputPath, "utf8")).toContain("retain-baseline=true");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
