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
  leaseRun: null as number | null,
  tagProtected: false,
  noCandidate: false,
  queries: [] as string[],
  ciSince: [] as (string | undefined)[],
  ciReads: 0,
  regressAfterSelection: false,
  artifactReads: 0,
  mainChanged: false,
  activeCount: 0,
  leaseExpired: false,
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
    if (args[0] === "for-each-ref") return state.tagProtected ? "v0.1.2-beta.1" : "";
    if (args[0] === "rev-parse")
      return state.mainChanged && state.refreshes > 1 ? "f".repeat(40) : state.tip;
    if (args[1] === "--first-parent") return [state.tip, state.next, state.old].join("\n");
    return state.old;
  },
  stableRequests: (sha: string) =>
    state.stable.has(sha) ? [{ sourceSha: sha, requestId: "stable", version: "0.1.2" }] : [],
  runs: (workflow: string, since?: string) => {
    state.ciSince.push(since);
    return workflow === "ci.yml" ? state.ci : state.builds;
  },
  trustedRun: (run: WorkflowRun, workflow: string) =>
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository.full_name === "lopes-felipe/f5" &&
    run.head_repository.full_name === "lopes-felipe/f5" &&
    run.path === ".github/workflows/" + workflow,
  acceptanceOnlyCommit: (sha: string) => state.acceptance.has(sha),
  releaseProfileAt: () => "all",
  requireCi: (sha: string) => {
    if (state.regressAfterSelection && ++state.ciReads > 1) throw new Error("CI regressed");
    if (state.failedCi.has(sha)) throw new Error("missing required matrix job");
    return state.ci.find((run) => run.head_sha === sha)!;
  },
  api: (path: string) =>
    path.endsWith("/artifacts")
      ? {
          artifacts: state.leaseRun
            ? [{ id: 99, name: "release-lease-" + state.leaseRun + "-1", expired: false }]
            : [],
        }
      : {
          ...state.builds.find((run) => run.id === Number(path.split("/").at(-1))),
          status:
            state.currentCompleted || (state.cancellationRace && state.cancellationPosted)
              ? "completed"
              : "in_progress",
        },
  readArtifactJson: async () => {
    state.artifactReads++;
    return state.noCandidate
      ? { candidateRun: null }
      : {
          sourceSha: state.leaseRun === 10 ? state.old : state.next,
          candidateRun: state.leaseRun,
          attempt: 1,
        };
  },
  pages: () => (state.draft ? [{ draft: true, tag_name: "v0.1.2-beta.1" }] : []),
  gh: (args: string[]) => {
    state.queries.push(args.at(-1)!);
    if (args.at(-1)!.includes("/artifacts?"))
      return JSON.stringify([
        {
          artifacts:
            state.leaseRun || state.noCandidate
              ? [
                  {
                    id: 99,
                    name:
                      "release-lease-" +
                      (state.noCandidate ? "none" : state.leaseRun + "-1") +
                      "-publisher-1",
                    expired: state.leaseExpired,
                  },
                ]
              : [],
        },
      ]);
    if (args.includes("POST")) {
      state.cancellationPosted = true;
      if (state.cancellationRace) throw new Error("completed concurrently");
      state.cancelled.push(Number(args.at(-1)!.split("/").at(-2)));
      return "";
    }
    const url = new URL("https://fixture/" + args.at(-1)!);
    const records = url.pathname.includes("release-publish")
      ? state.publishers
      : url.pathname.includes("release-upgrade")
        ? state.proofs
        : state.builds;
    return JSON.stringify([
      {
        total_count: state.activeCount || records.length,
        workflow_runs: records.filter((run) => run.status === url.searchParams.get("status")),
      },
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
    created_at: "2026-10-30T10:00:00Z",
    updated_at: "",
    run_started_at: "",
  };
}
beforeEach(() => {
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "beta");
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
  state.leaseRun = null;
  state.tagProtected = false;
  state.noCandidate = state.regressAfterSelection = false;
  state.queries = [];
  state.ciSince = [];
  state.ciReads = state.artifactReads = 0;
  state.mainChanged = state.leaseExpired = false;
  state.activeCount = 0;
});
afterEach(() => vi.unstubAllEnvs());
it("cancels only an older trusted beta after rechecking durable ordering", async () => {
  await coordinateReleases();
  expect(state.refreshes).toBe(2);
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
  if (kind === "draft") state.tagProtected = true;
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
it("protects a reserved tag even when a read-only token cannot list its draft", async () => {
  state.tagProtected = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
});
it.each([10, 99])(
  "protects rerun %s or allows unrelated unfinished work after a completed candidate selection",
  async (id) => {
    state.publishers = [run(state.tip, 30, "release-publish.yml")];
    state.leaseRun = id;
    if (id === 10)
      state.builds[0]!.run_attempt = 2; // Publishing verified attempt 1 during a rerun.
    else state.builds.push({ ...run(state.next, 99), status: "completed", conclusion: "success" });
    await coordinateReleases();
    expect(state.cancelled).toEqual(id === 10 ? [] : [10]);
  },
);
it("allows obsolete beta cleanup when the publisher selected no candidate", async () => {
  state.publishers = [run(state.tip, 30, "release-publish.yml")];
  state.noCandidate = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([10]);
});
it.each(["shadow", ""])("does no API work or cancellation with mode %s", async (mode) => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", mode);
  await coordinateReleases();
  expect(state.queries).toEqual([]);
  expect(state.refreshes).toBe(0);
  expect(JSON.parse(state.summaries[0]!).status).toBe("coordination-disabled");
});
it("allows cleanup in all mode", async () => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "all");
  await coordinateReleases();
  expect(state.cancelled).toEqual([10]);
});
it("refreshes exact-source CI immediately before cancellation", async () => {
  state.regressAfterSelection = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
  expect(JSON.parse(state.summaries[0]!).reason).toBe("Required CI no longer passes");
});
it("queries only active statuses, bounds CI history, and caches immutable leases", async () => {
  state.builds.push(run(state.old, 11));
  state.publishers = [run(state.tip, 30, "release-publish.yml")];
  state.leaseRun = 99; // Completed selected build; neither unfinished build is leased.
  await coordinateReleases();
  expect(state.cancelled).toEqual([10, 11]);
  expect(state.ciSince).toEqual(["2026-10-29T10:00:00.000Z"]);
  expect(state.artifactReads).toBe(1);
  const workflowQueries = state.queries.filter((query) => query.includes("/workflows/"));
  expect(
    workflowQueries.every((query) =>
      /&status=(in_progress|queued|waiting|pending|requested)$/.test(query),
    ),
  ).toBe(true);
  expect(workflowQueries).toHaveLength(17); // Five build queries, six protection queries per mutation.
});
it("defers cancellation when main changes after source selection", async () => {
  state.mainChanged = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
  expect(JSON.parse(state.summaries[0]!).status).toBe("coordination-deferred");
});
it("blocks cleanup when an active-run search could have been truncated", async () => {
  state.activeCount = 1000;
  await expect(coordinateReleases()).rejects.toThrow("Too many active workflow runs");
  expect(state.cancelled).toEqual([]);
});
it("preserves candidates referenced by queued upgrade qualification", async () => {
  state.proofs = [
    {
      ...run(state.tip, 40, "release-upgrade.yml"),
      status: "queued",
      display_title: "Upgrade 10-1-fingerprint",
    },
  ];
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
});
it("fails closed when a publisher selection marker has expired", async () => {
  state.publishers = [run(state.tip, 30, "release-publish.yml")];
  state.noCandidate = state.leaseExpired = true;
  await coordinateReleases();
  expect(state.cancelled).toEqual([]);
  expect(state.artifactReads).toBe(0);
});
