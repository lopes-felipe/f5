import { describe, expect, it, vi } from "vitest";
import { onlyUnassignedJobsFailed, rerunUnassignedCi } from "./rerun-unassigned-ci.ts";
import type { Gh } from "./lib/github-cli.ts";
import type { WorkflowRun } from "./release/release-github.ts";

const repository = "lopes-felipe/f5";
const root = "repos/" + repository + "/";
const head = "a".repeat(40);
const ciRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 7,
  head_sha: head,
  head_branch: "main",
  event: "push",
  run_attempt: 1,
  run_number: 7,
  status: "completed",
  conclusion: "failure",
  workflow_id: 1,
  path: ".github/workflows/ci.yml",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  created_at: "2026-11-06T10:00:00Z",
  updated_at: "2026-11-06T10:00:00Z",
  run_started_at: "",
  ...overrides,
});
const unassigned = { name: "macos-workspaces", conclusion: "cancelled", steps: [] };
const ranAndFailed = { name: "test", conclusion: "failure", steps: [{ name: "Run" }] };

function harness(state: {
  run?: WorkflowRun;
  current?: WorkflowRun;
  jobs?: { name: string; conclusion: string | null; steps?: unknown[] }[];
  files?: string[];
  main?: string;
}) {
  const paths: string[] = [];
  const gh = vi.fn<Gh>(async (args) => {
    const path = args.at(-1)!.slice(root.length);
    paths.push(path);
    if (path === "commits/main") return JSON.stringify({ sha: state.main ?? head });
    if (path.startsWith("actions/workflows/"))
      return JSON.stringify({ workflow_runs: state.run ? [state.run] : [] });
    if (path.startsWith("commits/"))
      return JSON.stringify([
        {
          files: (state.files ?? ["apps/web/src/main.ts"]).map((filename) => ({ filename })),
          parents: [{ sha: "b".repeat(40) }],
        },
      ]);
    if (path.endsWith("/jobs?per_page=100"))
      return JSON.stringify([
        { jobs: [{ name: "CI result", conclusion: "failure", steps: [{}] }, ...state.jobs!] },
      ]);
    if (path.endsWith("/rerun-failed-jobs")) return "";
    if (path.startsWith("actions/runs/"))
      return JSON.stringify(
        paths.filter((called) => called === "actions/runs/7").length > 1
          ? (state.current ?? state.run)
          : state.run,
      );
    throw new Error("Unexpected API " + path);
  });
  const reran = () => paths.some((called) => called.endsWith("/rerun-failed-jobs"));
  return { gh, reran };
}

describe("onlyUnassignedJobsFailed", () => {
  it("accepts runs whose only failures never started", () => {
    expect(onlyUnassignedJobsFailed([unassigned, { name: "test", conclusion: "success" }])).toBe(
      true,
    );
    expect(onlyUnassignedJobsFailed([unassigned, { name: "skipped", conclusion: "skipped" }])).toBe(
      true,
    );
  });
  it("rejects real failures, started cancellations and runs with nothing failed", () => {
    expect(onlyUnassignedJobsFailed([unassigned, ranAndFailed])).toBe(false);
    expect(onlyUnassignedJobsFailed([{ ...unassigned, steps: [{ name: "Set up job" }] }])).toBe(
      false,
    );
    expect(onlyUnassignedJobsFailed([{ name: "CI result", conclusion: "failure" }])).toBe(false);
  });
});

describe("rerunUnassignedCi", () => {
  it("reruns the current main run when only unassigned jobs failed", async () => {
    const { gh, reran } = harness({ run: ciRun(), jobs: [unassigned] });
    expect(await rerunUnassignedCi(repository, 7, gh)).toContain("attempt 2 of 3");
    expect(reran()).toBe(true);
  });
  it("finds the main HEAD run when no run id is given", async () => {
    const { gh, reran } = harness({ run: ciRun(), jobs: [unassigned] });
    await rerunUnassignedCi(repository, null, gh);
    expect(reran()).toBe(true);
  });
  it.each([
    ["a real failure", { jobs: [unassigned, ranAndFailed] }],
    ["a stale source", { jobs: [unassigned], main: "c".repeat(40) }],
    ["a release intent commit", { jobs: [unassigned], files: ["release-intent.json"] }],
    ["the attempt cap", { jobs: [unassigned], run: ciRun({ run_attempt: 3 }) }],
    ["a successful run", { jobs: [unassigned], run: ciRun({ conclusion: "success" }) }],
    ["an untrusted run", { jobs: [unassigned], run: ciRun({ event: "pull_request" }) }],
    ["a concurrent manual rerun", { jobs: [unassigned], current: ciRun({ run_attempt: 2 }) }],
  ])("leaves %s alone", async (_label, state) => {
    const { gh, reran } = harness({ run: ciRun(), ...state });
    await rerunUnassignedCi(repository, 7, gh);
    expect(reran()).toBe(false);
  });
});
