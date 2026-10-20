import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Job {
  uses?: string;
  needs?: string[];
  if?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  concurrency?: unknown;
  strategy?: { matrix?: unknown; "fail-fast"?: boolean };
}
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };

export function assertWorkflowPolicy(jobs: Record<string, Job>) {
  const gated = Object.keys(jobs).filter((id) => !["ci-result", "main-status"].includes(id));
  expect([...(jobs["ci-result"]?.needs ?? [])].sort()).toEqual(gated.sort());
  expect(jobs["ci-result"]?.if).toBe("always()");
  for (const id of gated) expect(jobs[id]?.["continue-on-error"], id).toBeUndefined();
  assertBoundedJobs(jobs);
}

function assertBoundedJobs(jobs: Record<string, Job>, visited = new Set<string>()) {
  for (const [id, job] of Object.entries(jobs)) {
    if (job.strategy?.matrix) expect(job.strategy["fail-fast"], id).toBe(false);
    if (job.uses) {
      // Reusable callers cannot declare timeout-minutes. Validate every leaf instead.
      expect(job.uses).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.yml$/);
      if (visited.has(job.uses)) throw new Error("Recursive workflow calls");
      const called = parse(
        readFileSync(new URL(`../${job.uses.slice(2)}`, import.meta.url), "utf8"),
      ) as { jobs: Record<string, Job> };
      for (const [calledId, calledJob] of Object.entries(called.jobs))
        expect(calledJob["continue-on-error"], calledId).toBeUndefined();
      assertBoundedJobs(called.jobs, new Set([...visited, job.uses]));
    } else expect(job["timeout-minutes"], id).toBeGreaterThan(0);
  }
}

describe("CI workflow policy", () => {
  it("gates every job and bounds all jobs and matrices", () => assertWorkflowPolicy(workflow.jobs));
  it("keeps the notifier outside concurrency groups that can cancel push runs", () => {
    expect(workflow.jobs["main-status"]!.concurrency).toBeUndefined();
  });
  it("rejects an unbounded job in a reusable workflow", () => {
    expect(() => assertBoundedJobs({ job: {} })).toThrow();
  });
  it("rejects a job missing from CI result", () => {
    const jobs = structuredClone(workflow.jobs);
    jobs["ci-result"]!.needs = jobs["ci-result"]!.needs!.filter((id) => id !== "browser");
    expect(() => assertWorkflowPolicy(jobs)).toThrow();
  });
});
