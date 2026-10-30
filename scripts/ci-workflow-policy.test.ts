import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { inventories } from "./ci-test-summary.ts";

interface Job {
  needs?: string[];
  if?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  concurrency?: unknown;
  permissions?: Record<string, string>;
  strategy?: { matrix?: unknown; "fail-fast"?: boolean };
  steps?: { id?: string; uses?: string; if?: string; name?: string; run?: string }[];
}
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job>; permissions: Record<string, string> };

export function assertWorkflowPolicy(jobs: Record<string, Job>) {
  const gated = Object.keys(jobs).filter((id) => !["ci-result", "main-status"].includes(id));
  expect([...(jobs["ci-result"]?.needs ?? [])].sort()).toEqual(gated.sort());
  expect(jobs["ci-result"]?.if).toBe("always()");
  for (const id of gated) expect(jobs[id]?.["continue-on-error"], id).toBeUndefined();
  for (const [id, job] of Object.entries(jobs)) {
    expect(job["timeout-minutes"], id).toBeGreaterThan(0);
    if (job.strategy?.matrix) expect(job.strategy["fail-fast"], id).toBe(false);
  }
}

describe("CI workflow policy", () => {
  it("gates every job and bounds all jobs and matrices", () => assertWorkflowPolicy(workflow.jobs));
  it("has a report inventory for every configured server unit shard", () => {
    expect(workflow.jobs["server-unit"]!.strategy!.matrix).toEqual({ shard: [1, 2] });
    expect(workflow.jobs["windows-server-unit"]!.strategy!.matrix).toEqual({ shard: [1, 2, 3] });
    for (const job of ["server-unit", "windows-server-unit"]) {
      const matrix = workflow.jobs[job]!.strategy!.matrix as { shard: number[] };
      for (const shard of matrix.shard) {
        const event = `server-unit-${shard}`;
        expect(inventories[event]).toEqual([{ packageName: "suites", event }]);
      }
    }
  });
  it("uploads reports, including flaky records, from every job that prepares them", () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const runs = (job.steps ?? []).map((step) => step.run ?? "");
      const prepares = runs.some((run) => run.includes("ci-test-summary.ts --prepare"));
      if (runs.some((run) => run.includes("test:desktop-smoke")))
        expect(prepares, `${id} records flaky smoke retries`).toBe(true);
      if (!prepares) continue;
      const upload = job.steps!.find(
        (step) =>
          step.uses?.startsWith("actions/upload-artifact@") &&
          String((step as { with?: { name?: string } }).with?.name).startsWith("reports-"),
      );
      expect(upload, `${id} uploads reports`).toBeDefined();
      expect(upload!.if, id).toMatch(/^always\(\)/);
    }
  });
  it("retries desktop smoke only through ci-retry-once and wraps nothing else", () => {
    const runs = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : [])),
    );
    const smoke = runs.filter((run) => run.includes("test:desktop-smoke"));
    expect(smoke).toHaveLength(3);
    for (const run of smoke)
      expect(run.trim()).toMatch(
        /^node scripts\/ci-retry-once\.ts --step desktop-smoke -- (xvfb-run --auto-servernum )?bun run test:desktop-smoke$/,
      );
    expect(runs.filter((run) => run.includes("ci-retry-once"))).toEqual(smoke);
  });
  it("keeps the notifier outside concurrency groups that can cancel push runs", () => {
    expect(workflow.jobs["main-status"]!.concurrency).toBeUndefined();
  });
  it("classifies changes inside every heavy job without a scheduling prerequisite", () => {
    expect(workflow.jobs.changes).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const id of [
      "server-unit",
      "windows-server-unit",
      "browser",
      "desktop",
      "windows-build",
      "macos-profiles",
      "macos-descriptor-drift",
    ]) {
      const job = workflow.jobs[id]!;
      expect(job.permissions, id).toEqual({ contents: "read", "pull-requests": "read" });
      expect(job.needs, id).toBeUndefined();
      expect(job.if, id).toBeUndefined();
      const steps = job.steps!;
      const changes = steps.findIndex((step) => step.uses === "./.github/actions/changes");
      const install = steps.findIndex((step) => step.id === "install");
      expect(changes, id).toBeGreaterThan(-1);
      expect(install, id).toBeGreaterThan(changes);
      expect(steps[install]!.if, id).toBe("steps.changes.outputs.heavy == 'true'");
      for (const step of steps.slice(install + 1)) {
        // Failed tests must not hide later suites, summaries, diagnostics or uploads.
        expect(step.if, id + "/" + (step.name ?? step.uses)).toMatch(
          /!cancelled\(\).*steps\.install\.outcome == 'success'|always\(\).*steps\.changes\.outputs\.heavy == 'true'/,
        );
      }
    }
  });
  it("retains the exact docs-only filter and bypasses it for main/nightly/manual runs", () => {
    const action = parse(
      readFileSync(new URL("../.github/actions/changes/action.yml", import.meta.url), "utf8"),
    );
    expect(action.outputs.heavy.value).toBe(
      "${{ github.event_name != 'pull_request' || steps.paths.outputs.code == 'true' }}",
    );
    const filter = action.runs.steps[0];
    expect(filter.if).toBe("github.event_name == 'pull_request'");
    expect(filter.with["predicate-quantifier"]).toBe("some-with-excludes");
    expect(parse(filter.with.filters)).toEqual({ code: ["**", "!**/*.md", "!docs/**"] });
  });
  it("cancels obsolete packaging PRs without cancelling release rehearsals", () => {
    const release = parse(
      readFileSync(
        new URL("../.github/workflows/windows-release-checks.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(release.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(release.concurrency.group).toContain("github.event.pull_request.number");
    expect(release.concurrency.group).toContain("github.run_id");
  });
  it("keeps cache benchmarking manual, bounded and complete", () => {
    const benchmark = parse(
      readFileSync(new URL("../.github/workflows/ci-setup-benchmark.yml", import.meta.url), "utf8"),
    );
    expect(Object.keys(benchmark.on)).toEqual(["workflow_dispatch"]);
    expect(benchmark.jobs.setup.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": 2,
      matrix: { pair: [1, 2, 3], mode: ["combined", "split", "electron-only"] },
    });
    expect(benchmark.concurrency.group).toBe("ci-setup-benchmark-${{ inputs.cache-suffix }}");
    expect(benchmark.concurrency["cancel-in-progress"]).toBe(false);
    const setup = benchmark.jobs.setup.steps.find(
      (step: { uses?: string }) => step.uses === "./.github/actions/setup",
    );
    expect(setup.with["cache-bun"]).toContain("matrix.mode != 'electron-only'");
    expect(setup.with["cache-suffix"]).toContain("matrix.mode");
    expect(benchmark.jobs.summary.needs).toBe("setup");
    expect(benchmark.jobs.summary.if).toBe("always()");
    expect(benchmark.permissions.actions).toBe("read");
    for (const job of Object.values(benchmark.jobs) as Job[])
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });
  it("keeps frozen installs and Electron verification with independently versioned caches", () => {
    const action = parse(
      readFileSync(new URL("../.github/actions/setup/action.yml", import.meta.url), "utf8"),
    );
    expect(action.inputs["cache-bun"].default).toBe("true");
    expect(action.inputs["cache-layout"].default).toBe("split");
    const steps = action.runs.steps as {
      name?: string;
      run?: string;
      with?: { path: string; key: string };
    }[];
    expect(steps.find((step) => step.name === "Install dependencies")!.run).toBe(
      "node scripts/retry-install.ts",
    );
    expect(steps.find((step) => step.name === "Verify Electron installation")!.run).toContain(
      "fs.existsSync(resolved)",
    );
    const electron = steps.find((step) => step.name === "Restore Electron downloads")!.with!;
    expect(electron.key).toContain("steps.electron.outputs.version");
    expect(electron.key).toContain("runner.os");
    expect(electron.key).toContain("runner.arch");
    expect(electron.path).not.toContain(".bun");
    expect(steps.find((step) => step.name === "Restore Bun packages")!.with!.path).toBe(
      "~/.bun/install/cache",
    );
  });
  it("rejects a job missing from CI result", () => {
    const jobs = structuredClone(workflow.jobs);
    jobs["ci-result"]!.needs = jobs["ci-result"]!.needs!.filter((id) => id !== "browser");
    expect(() => assertWorkflowPolicy(jobs)).toThrow();
  });
});

const readWorkflow = (file: string) =>
  parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency?: unknown;
    jobs: Record<string, Job & { "runs-on"?: string; env?: Record<string, string> }>;
  };

describe("flake workflows", () => {
  it("passes every variable the CI reporter reads through Turbo's strict env", () => {
    const turbo = JSON.parse(readFileSync(new URL("../turbo.json", import.meta.url), "utf8")) as {
      globalPassThroughEnv: string[];
      tasks: { test: { passThroughEnv: string[] } };
    };
    const allowed = new Set([...turbo.globalPassThroughEnv, ...turbo.tasks.test.passThroughEnv]);
    const source = readFileSync(new URL("./lib/ci-test-reports.ts", import.meta.url), "utf8");
    const read = [...new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!))];
    expect(read).toEqual(expect.arrayContaining(["F5_CI_REPORT_DIR", "F5_CI_TEST_RETRY"]));
    expect(read.filter((name) => !allowed.has(name))).toEqual([]);
  });

  it("files flakes after CI with least privilege and never runs PR code", () => {
    const ledger = readWorkflow("ci-flakes.yml");
    expect(ledger.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"] } });
    expect(ledger.permissions).toEqual({ contents: "read" });
    // A pending run must not cancel the previous one and lose its occurrences.
    expect(ledger.concurrency).toBeUndefined();
    expect(Object.keys(ledger.jobs)).toEqual(["ledger"]);
    const job = ledger.jobs.ledger!;
    expect(job.permissions).toEqual({ contents: "read", actions: "read", issues: "write" });
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job.concurrency).toBeUndefined();
    // Fork PRs control their artifacts; only same-repo runs may write issues.
    expect(job.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    const checkout = job.steps!.find((step) => step.uses?.startsWith("actions/checkout@")) as {
      with?: Record<string, unknown>;
    };
    expect(checkout.with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.event.repository.default_branch }}",
    });
    const runs = job.steps!.map((step) => step.run ?? "").join("\n");
    // Untrusted event fields reach scripts only through the environment.
    expect(runs).not.toContain("${{");
    expect(runs).not.toMatch(/\bbun (install|run)\b|npm |npx /);
    expect(runs).toContain("node scripts/ci-flake-ledger.ts");
  });
  it("repeats a single target on demand with bounded work and no write access", () => {
    const repro = readWorkflow("ci-flake-repro.yml");
    expect(Object.keys(repro.on)).toEqual(["workflow_dispatch"]);
    expect(repro.permissions).toEqual({ contents: "read" });
    const job = repro.jobs.repeat!;
    expect(job.permissions).toBeUndefined();
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(90);
    const runs = job.steps!.map((step) => step.run ?? "").join("\n");
    expect(runs).not.toContain("${{");
    expect(runs).toContain('node scripts/ci-repeat.ts "${flags[@]}" -- "${command[@]}"');
    expect(job.env).toMatchObject({ FILTER: "${{ inputs.filter }}" });
  });
});
