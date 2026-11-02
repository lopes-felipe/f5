import { describe, expect, it, vi } from "vitest";
import { supersedeQueuedCi } from "./supersede-queued-ci.ts";
import type { Gh } from "./lib/github-cli.ts";
import type { WorkflowRun } from "./release/release-github.ts";

const repository = "lopes-felipe/f5";
const root = "repos/" + repository + "/";
const run = (id: number): WorkflowRun => ({
  id,
  head_sha: id.toString(16).padStart(40, "0"),
  head_branch: "main",
  event: "push",
  run_attempt: 1,
  run_number: id,
  status: "queued",
  conclusion: null,
  workflow_id: 1,
  path: ".github/workflows/ci.yml",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  created_at: "2026-11-02T10:00:00Z",
  updated_at: "2026-11-02T10:00:00Z",
  run_started_at: "",
});

function harness() {
  const state = {
    newest: run(3) as WorkflowRun | undefined,
    newestRuns: null as WorkflowRun[] | null,
    queued: [[run(1)], [run(2), run(3)]],
    total: 3,
    files: [[{ filename: "src/main.ts" }]] as {
      filename: string;
      previous_filename?: string;
      status?: string;
    }[][],
    filesBySha: new Map<string, { filename: string; previous_filename?: string }[]>(),
    parentsBySha: new Map<string, { sha: string }[]>(),
    comparison: "ahead",
    current: new Map<number, WorkflowRun>(),
    jobs: [[{ status: "queued", started_at: null, runner_id: 0 }]] as {
      status: string;
      started_at: string | null;
      runner_id: number | null;
    }[][],
    fileError: false,
    cancelError: false,
    afterCancel: "queued",
  };
  const gh = vi.fn<Gh>(async (args) => {
    const path = args.at(-1)!.slice(root.length);
    let response: unknown;
    if (path.includes("status=queued"))
      response = state.queued.map((workflow_runs) => ({ total_count: state.total, workflow_runs }));
    else if (path.startsWith("actions/workflows/"))
      response = {
        workflow_runs: state.newestRuns ?? (state.newest ? [state.newest] : []),
      };
    else if (path.startsWith("commits/")) {
      if (state.fileError) throw new Error("commit API unavailable");
      const sha = path.split("/")[1]!.split("?")[0]!;
      const files = state.filesBySha.get(sha);
      response = (files ? [files] : state.files).map((files) => ({
        files,
        parents: state.parentsBySha.get(sha) ?? [{ sha: "0".repeat(40) }],
      }));
    } else if (path.startsWith("compare/")) response = { status: state.comparison };
    else if (path.endsWith("/cancel")) {
      if (state.cancelError) {
        state.current.set(1, { ...run(1), status: state.afterCancel });
        throw new Error("cancel API unavailable");
      }
      return "";
    } else if (path.includes("/jobs?")) response = state.jobs.map((jobs) => ({ jobs }));
    else if (/^actions\/runs\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      response = state.current.get(id) ?? run(id);
    } else throw new Error("Unexpected gh request: " + args.join(" "));
    return JSON.stringify(response);
  });
  const cancellations = () => gh.mock.calls.filter(([args]) => args.includes("POST"));
  return { state, gh, cancellations };
}

describe("supersedeQueuedCi", () => {
  it("cancels only older queued pushes across all result pages", async () => {
    const { gh, cancellations } = harness();
    expect(await supersedeQueuedCi(repository, gh)).toEqual([1, 2]);
    expect(cancellations().map(([args]) => args)).toEqual([
      ["api", "--method", "POST", root + "actions/runs/1/cancel"],
      ["api", "--method", "POST", root + "actions/runs/2/cancel"],
    ]);
    expect(gh).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      root + "actions/workflows/ci.yml/runs?branch=main&event=push&status=queued&per_page=100",
    ]);
  });

  it("uses the latest beta-eligible commit when the newest push is acceptance-only", async () => {
    const { state, gh, cancellations } = harness();
    state.newestRuns = [run(3), run(2), run(1)];
    state.filesBySha.set(run(3).head_sha, [
      { filename: "docs/computer-certification/acceptance-1.2.3-codex.json" },
    ]);
    state.filesBySha.set(run(2).head_sha, [{ filename: "src/main.ts" }]);
    expect(await supersedeQueuedCi(repository, gh)).toEqual([1]);
    expect(cancellations()).toHaveLength(1);
    expect(gh).toHaveBeenCalledWith([
      "api",
      "repos/" +
        repository +
        "/compare/" +
        run(1).head_sha +
        "..." +
        run(2).head_sha +
        "?per_page=1",
    ]);
  });

  it("keeps queued eligible sources when every newer run is acceptance-only", async () => {
    const { state, gh, cancellations } = harness();
    state.newestRuns = [run(3), run(2)];
    state.filesBySha.set(run(3).head_sha, [
      { filename: "docs/computer-certification/acceptance-3.json" },
    ]);
    state.queued = [[run(2)]];
    expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
    expect(cancellations()).toEqual([]);
  });

  it("does not mistake a rename of source code into an acceptance report for acceptance-only changes", async () => {
    const { state, gh } = harness();
    state.filesBySha.set(run(3).head_sha, [
      {
        filename: "docs/computer-certification/acceptance-3.json",
        previous_filename: "src/main.ts",
      },
    ]);
    expect(await supersedeQueuedCi(repository, gh)).toEqual([1, 2]);
  });

  it.each(["failure", "cancelled", "timed_out", "action_required"])(
    "keeps older sources when the newest eligible run already ended in %s",
    async (conclusion) => {
      const { state, gh, cancellations } = harness();
      state.newest = { ...run(3), status: "completed", conclusion };
      expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
      expect(cancellations()).toEqual([]);
    },
  );

  it("uses a successful newest eligible run to supersede queued sources", async () => {
    const { state, gh } = harness();
    state.newest = { ...run(3), status: "completed", conclusion: "success" };
    expect(await supersedeQueuedCi(repository, gh)).toEqual([1, 2]);
  });

  it("keeps true merge commits whose API diff cannot prove first-parent intent safety", async () => {
    const { state, gh, cancellations } = harness();
    state.parentsBySha.set(
      run(1).head_sha,
      [run(2), run(3)].map((run) => ({ sha: run.head_sha })),
    );
    state.queued = [[run(1)]];
    expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
    expect(cancellations()).toEqual([]);
  });

  it("does not use an ambiguous merge commit as a replacement source", async () => {
    const { state, gh, cancellations } = harness();
    state.parentsBySha.set(
      run(3).head_sha,
      [run(1), run(2)].map((run) => ({ sha: run.head_sha })),
    );
    expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
    expect(cancellations()).toEqual([]);
  });

  it.each(["added", "modified", "removed", "renamed"])(
    "protects %s release intent files",
    async (status) => {
      const { state, gh, cancellations } = harness();
      state.files = [[{ filename: "release-intent.json", status }]];
      expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
      expect(cancellations()).toEqual([]);
    },
  );

  it("protects an intent renamed away on a later file page", async () => {
    const { state, gh, cancellations } = harness();
    state.files.push([
      { filename: "archived-intent.json", previous_filename: "release-intent.json" },
    ]);
    await supersedeQueuedCi(repository, gh);
    expect(cancellations()).toEqual([]);
  });

  it("preserves runs when the commit API file limit could hide intent changes", async () => {
    const { state, gh, cancellations } = harness();
    state.files = [Array.from({ length: 3000 }, (_, i) => ({ filename: "file-" + i }))];
    await supersedeQueuedCi(repository, gh);
    expect(cancellations()).toEqual([]);
  });

  it.each([
    { status: "in_progress" },
    { status: "completed" },
    { status: "waiting" },
    { event: "pull_request" },
    { event: "schedule" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { path: ".github/workflows/release.yml" },
    { repository: { full_name: "another/repo" } },
    { head_repository: { full_name: "another/repo" } },
    { head_sha: "invalid" },
    { run_number: 4 },
    { head_sha: run(3).head_sha },
  ])("preserves ineligible run %j", async (changes) => {
    const { state, gh, cancellations } = harness();
    state.queued = [[{ ...run(1), ...changes }]];
    await supersedeQueuedCi(repository, gh);
    expect(cancellations()).toEqual([]);
  });

  it.each(["identical", "behind", "diverged"])(
    "preserves runs without a newer descendant (%s)",
    async (comparison) => {
      const { state, gh, cancellations } = harness();
      state.comparison = comparison;
      await supersedeQueuedCi(repository, gh);
      expect(cancellations()).toEqual([]);
    },
  );

  it.each([
    { status: "in_progress" },
    { status: "completed" },
    { run_attempt: 2 },
    { head_sha: run(2).head_sha },
    { id: 99 },
    { head_repository: { full_name: "another/repo" } },
  ])("rechecks mutable run identity before cancelling (%j)", async (changes) => {
    const { state, gh, cancellations } = harness();
    state.queued = [[run(1)]];
    state.current.set(1, { ...run(1), ...changes });
    await supersedeQueuedCi(repository, gh);
    expect(cancellations()).toEqual([]);
  });

  it.each([
    { status: "in_progress", started_at: null, runner_id: 12 },
    { status: "completed", started_at: "2026-11-02T10:00:00Z", runner_id: 12 },
    { status: "queued", started_at: "2026-11-02T10:00:00Z", runner_id: 12 },
    { status: "queued", started_at: null, runner_id: null },
  ])("preserves runs whose jobs have started (%j)", async (job) => {
    const { state, gh, cancellations } = harness();
    state.jobs.push([job]);
    await supersedeQueuedCi(repository, gh);
    expect(cancellations()).toEqual([]);
  });

  it("cancels a queued job with started_at set and runner_id zero", async () => {
    const { state, gh, cancellations } = harness();
    state.queued = [[run(1)]];
    state.jobs = [
      [
        {
          status: "queued",
          started_at: "2026-11-02T10:00:00Z",
          runner_id: 0,
        },
      ],
    ];
    expect(await supersedeQueuedCi(repository, gh)).toEqual([1]);
    expect(cancellations()).toHaveLength(1);
  });

  it.each([undefined, { ...run(3), event: "pull_request" }])(
    "does nothing without a trusted newest main push",
    async (newest) => {
      const { state, gh, cancellations } = harness();
      state.newest = newest;
      await supersedeQueuedCi(repository, gh);
      expect(cancellations()).toEqual([]);
      expect(gh).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when the workflow search limit could truncate the queue", async () => {
    const { state, gh, cancellations } = harness();
    state.total = 1000;
    await expect(supersedeQueuedCi(repository, gh)).rejects.toThrow("Too many queued CI runs");
    expect(cancellations()).toEqual([]);
  });

  it("preserves runs when intent protection cannot be checked", async () => {
    const { state, gh, cancellations } = harness();
    state.fileError = true;
    await expect(supersedeQueuedCi(repository, gh)).rejects.toThrow("commit API unavailable");
    expect(cancellations()).toEqual([]);
  });

  it.each(["in_progress", "completed"])(
    "tolerates a cancellation rejected after the run becomes %s",
    async (status) => {
      const { state, gh } = harness();
      state.queued = [[run(1)]];
      state.cancelError = true;
      state.afterCancel = status;
      expect(await supersedeQueuedCi(repository, gh)).toEqual([]);
    },
  );

  it("reports cancellation errors while the run remains queued", async () => {
    const { state, gh } = harness();
    state.cancelError = true;
    await expect(supersedeQueuedCi(repository, gh)).rejects.toThrow("cancel API unavailable");
  });
});
