import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkflowRun } from "./release/release-github.ts";
const state = vi.hoisted(() => ({
  old: "a".repeat(40),
  next: "b".repeat(40),
  tip: "c".repeat(40),
  builds: [] as WorkflowRun[],
  ci: [] as WorkflowRun[],
  publishers: [] as WorkflowRun[],
  proofs: [] as (WorkflowRun & { display_title: string })[],
  stable: new Set<string>(),
  acceptance: new Set<string>(),
  failedCi: new Set<string>(),
  draft: false,
  currentCompleted: false,
  cancellationRace: false,
  cancellationPosted: false,
  refreshes: 0,
  cancelled: [] as number[],
  summaries: [] as string[],
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeFileSync: (_name: string, value: string) => state.summaries.push(value),
}));
vi.mock("./release/release-github.ts", () => ({
  repository: "lopes-felipe/f5",
  git: (args: string[]) => {
    if (args[0] === "fetch") {
      state.refreshes++;
      return "";
    }
    if (args[0] === "rev-parse") return state.tip;
    if (args[1] === "--first-parent") return [state.tip, state.next, state.old].join("\n");
    return state.old;
  },
  stableRequests: (sha: string) =>
    state.stable.has(sha) ? [{ sourceSha: sha, requestId: "stable", version: "0.1.2" }] : [],
  runs: (workflow: string) => (workflow === "ci.yml" ? state.ci : state.builds),
  trustedRun: (run: WorkflowRun, workflow: string) =>
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository.full_name === "lopes-felipe/f5" &&
    run.head_repository.full_name === "lopes-felipe/f5" &&
    run.path === ".github/workflows/" + workflow,
  acceptanceOnlyCommit: (sha: string) => state.acceptance.has(sha),
  releaseProfileAt: () => "all",
  requireCi: (sha: string) => {
    if (state.failedCi.has(sha)) throw new Error("missing required matrix job");
    return state.ci.find((run) => run.head_sha === sha)!;
  },
  api: () => ({
    ...state.builds[0],
    status:
      state.currentCompleted || (state.cancellationRace && state.cancellationPosted)
        ? "completed"
        : "in_progress",
  }),
  pages: () => (state.draft ? [{ draft: true, tag_name: "v0.1.2-beta.1" }] : []),
  gh: (args: string[]) => {
    if (args.includes("POST")) {
      state.cancellationPosted = true;
      if (state.cancellationRace) throw new Error("completed concurrently");
      state.cancelled.push(Number(args.at(-1)!.split("/").at(-2)));
      return "";
    }
    return JSON.stringify([
      { workflow_runs: args.at(-1)!.includes("release-publish") ? state.publishers : state.proofs },
    ]);
  },
}));
import { coordinateReleases } from "./coordinate-releases.ts";
function run(sha: string, id: number, workflow = "release.yml"): WorkflowRun {
  return {
    id,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "in_progress",
    conclusion: null,
    run_attempt: 1,
    run_number: id,
    workflow_id: 1,
    path: ".github/workflows/" + workflow,
    repository: { full_name: "lopes-felipe/f5" },
    head_repository: { full_name: "lopes-felipe/f5" },
    created_at: "",
    updated_at: "",
    run_started_at: "",
  };
}
beforeEach(() => {
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
  state.builds = [run(state.old, 10)];
  state.ci = [{ ...run(state.next, 20, "ci.yml"), status: "completed", conclusion: "success" }];
  state.publishers = [];
  state.proofs = [];
  state.stable.clear();
  state.acceptance.clear();
  state.failedCi.clear();
  state.draft = state.currentCompleted = state.cancellationRace = false;
  state.cancellationPosted = false;
  state.refreshes = 0;
  state.cancelled = [];
  state.summaries = [];
});
afterEach(() => vi.unstubAllEnvs());
it("cancels only an older trusted beta after rechecking durable ordering", async () => {
  await coordinateReleases();
  expect(state.refreshes).toBe(1);
  expect(state.cancelled).toEqual([10]);
  expect(JSON.parse(state.summaries[0]!).status).toBe("superseded-beta");
});
it.each([
  "stable",
  "acceptance",
  "failed",
  "missing",
  "draft",
  "publisher",
  "proof",
  "untrusted",
  "complete",
])("preserves protected work: %s", async (kind) => {
  if (kind === "stable") state.stable.add(state.old);
  if (kind === "acceptance") state.acceptance.add(state.next);
  if (kind === "failed") state.ci[0]!.conclusion = "failure";
  if (kind === "missing") state.failedCi.add(state.next);
  if (kind === "draft") state.draft = true;
  if (kind === "publisher") state.publishers = [run(state.tip, 30, "release-publish.yml")];
  if (kind === "proof")
    state.proofs = [
      { ...run(state.tip, 40, "release-upgrade.yml"), display_title: "Upgrade 10-1-fingerprint" },
    ];
  if (kind === "untrusted") state.builds[0]!.head_repository.full_name = "attacker/fork";
  if (kind === "complete") state.currentCompleted = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
  expect(state.cancellationPosted).toBe(false);
});
it("does not cancel a candidate when the current CI attempt regresses", async () => {
  state.ci.push({ ...state.ci[0]!, run_attempt: 2, conclusion: "failure" });
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
});
it("treats completion before cancellation as harmless", async () => {
  state.cancellationRace = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
  expect(state.cancellationPosted).toBe(true);
});
