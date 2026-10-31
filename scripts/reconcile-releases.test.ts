import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReleaseCandidate, StableRequest } from "./release/release-candidate.ts";
import type { WorkflowRun } from "./release/release-github.ts";

const state = vi.hoisted(() => ({
  a: "a".repeat(40),
  b: "b".repeat(40),
  c: "c".repeat(40),
  history: [] as string[],
  candidate: null as unknown as ReleaseCandidate,
  intents: [] as StableRequest[],
  refreshedIntents: null as StableRequest[] | null,
  intentReads: 0,
  ci: [] as WorkflowRun[],
  builds: [] as WorkflowRun[],
  releases: [] as { tag_name: string; draft: boolean; assets: { name: string }[] }[],
  acceptance: new Set<string>(),
  failedCi: new Set<string>(),
  cache: false,
  proof: null as WorkflowRun | null,
  proofMissing: false,
  changedBaselines: false,
  staleBaseline: false,
  upgradeReads: 0,
  qualification: vi.fn(),
  load: vi.fn(),
  assemble: vi.fn(),
  publish: vi.fn(),
  verifyPublished: vi.fn(),
  gate: vi.fn(),
  api: vi.fn(),
  gh: vi.fn(),
  writes: new Map<string, string>(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  mkdtempSync: () => "/tmp/f5-reconcile-test-owned",
  writeFileSync: (path: string, value: string) => state.writes.set(path, value),
  appendFileSync: vi.fn(),
}));
vi.mock("./release/release-github.ts", async (original) => ({
  ...(await original<typeof import("./release/release-github.ts")>()),
  repository: "lopes-felipe/f5",
  git: (args: string[]) => {
    if (args[0] === "rev-parse") return state.history[0];
    if (args[0] === "rev-list" && args[1] === "--first-parent") return state.history.join("\n");
    if (args[0] === "rev-list") return args.at(-1) === "v0.1.1" ? state.a : state.b;
    if (args[0] === "show") return "2026-10-30T10:00:00Z";
    if (args[0] === "fetch") return "";
    throw new Error("Unexpected Git " + args.join(" "));
  },
  runs: (workflow: string) => (workflow === "ci.yml" ? state.ci : state.builds),
  requireCi: state.qualification,
  releaseProfileAt: () => "all",
  publisherIdentity: () => "publisher-content-hash",
  stableRequests: () =>
    ++state.intentReads > 1 && state.refreshedIntents ? state.refreshedIntents : state.intents,
  acceptanceOnlyCommit: (sha: string) => state.acceptance.has(sha),
  trustedRun: () => true,
  gh: state.gh,
  api: state.api,
  readArtifactJson: async (_artifact: unknown, file: string) =>
    file === "release-summary.json"
      ? { sourceSha: state.candidate.sourceSha, candidateRun: 100, attempt: 1 }
      : { key: "100-1-baselines", candidate: state.candidate },
}));
vi.mock("./release/candidate-store.ts", () => ({
  loadCandidate: state.load,
  runArtifacts: () =>
    state.proofMissing ? [] : [{ id: 9, name: "upgrade-proof-100-1-baselines-attempt-2" }],
}));
vi.mock("./lib/release-profile.ts", async (original) => ({
  ...(await original<typeof import("./lib/release-profile.ts")>()),
  fetchReleaseSummaries: () => state.releases,
}));
vi.mock("./release/publish-candidate.ts", () => ({
  assembleCandidate: state.assemble,
  publishCandidate: state.publish,
  verifyPublicRelease: vi.fn(),
  verifyCandidateCertification: vi.fn(),
  verifyPublishedCandidate: state.verifyPublished,
}));
vi.mock("./release/release-publication-gate.ts", () => ({ publicationGate: state.gate }));
vi.mock("./release/release-upgrade-proof.ts", () => ({
  sameBaselines: () => !state.changedBaselines,
  upgradePlan: () => ({
    key: state.staleBaseline && ++state.upgradeReads > 1 ? "changed" : "100-1-baselines",
    baselines: [],
    cliBaseline: "0.1.1",
    cliTargets: [],
  }),
}));
import { reconcileReleases } from "./reconcile-releases.ts";

const run = (sha: string, id: number): WorkflowRun => ({
  id,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  run_attempt: 1,
  run_number: id,
  status: "completed",
  conclusion: "success",
  workflow_id: 1,
  path: ".github/workflows/ci.yml",
  repository: { full_name: "lopes-felipe/f5" },
  head_repository: { full_name: "lopes-felipe/f5" },
  created_at: "2026-10-30T10:00:00Z",
  updated_at: "2026-10-30T10:10:00Z",
  run_started_at: "2026-10-30T10:01:00Z",
});
beforeEach(() => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "shadow");
  state.history = [state.b, state.a];
  state.candidate = {
    sourceSha: state.b,
    runId: 100,
    runAttempt: 1,
    version: "0.1.2-beta.1",
    kind: "beta",
    profile: "all",
    windowsBaselines: [],
    artifacts: [],
  } as unknown as ReleaseCandidate;
  state.intents = [];
  state.refreshedIntents = null;
  state.intentReads = 0;
  state.ci = [run(state.b, 200), run(state.a, 199)];
  state.builds = [run(state.b, 100)];
  state.releases = [{ tag_name: "v0.1.1", draft: false, assets: [] }];
  state.acceptance.clear();
  state.failedCi.clear();
  state.cache = false;
  state.proof = null;
  state.changedBaselines = false;
  state.staleBaseline = false;
  state.upgradeReads = 0;
  state.proofMissing = false;
  state.writes.clear();
  for (const mock of [
    state.qualification,
    state.load,
    state.assemble,
    state.publish,
    state.verifyPublished,
    state.gate,
    state.api,
    state.gh,
  ])
    mock.mockReset();
  state.qualification.mockImplementation((sha: string) => {
    if (state.failedCi.has(sha)) throw new Error("required job failed");
    return state.ci.find((r) => r.head_sha === sha)!;
  });
  state.load.mockImplementation(async () => state.candidate);
  state.verifyPublished.mockImplementation(async () => state.candidate);
  state.publish.mockImplementation(
    async (_candidate: unknown, _directory: unknown, gate: () => void) => gate(),
  );
  state.api.mockImplementation((path: string) => {
    if (path.startsWith("actions/artifacts?"))
      return {
        artifacts: state.cache ? [{ id: 1, expired: false, workflow_run: { id: 300 } }] : [],
      };
    if (path === "actions/runs/300")
      return { ...run(state.b, 300), path: ".github/workflows/release-publish.yml" };
    if (path.startsWith("actions/workflows/release-upgrade.yml"))
      return {
        workflow_runs: state.proof
          ? [
              {
                ...state.proof,
                path: ".github/workflows/release-upgrade.yml",
                display_title: "Upgrade 100-1-baselines",
              },
            ]
          : [],
      };
    if (path.startsWith("releases/tags/")) return { published_at: "2026-10-30T10:15:00Z" };
    if (path.startsWith("commits/"))
      return { commit: { committer: { date: "2026-10-30T10:00:00Z" } } };
    throw new Error("Unexpected API " + path);
  });
});
afterEach(() => vi.unstubAllEnvs());
const pinned = (): StableRequest => ({
  version: "0.1.2",
  sourceSha: state.b,
  requestId: "00000000-0000-4000-8000-000000000001",
});
it("checks only the newest eligible passing source in main order", async () => {
  state.history.unshift(state.c);
  state.ci.push(run(state.c, 201)); // Workflow listing order is deliberately different.
  state.builds.unshift(run(state.c, 101));
  state.candidate = { ...state.candidate, sourceSha: state.c };
  await reconcileReleases();
  expect(state.qualification.mock.calls.map((c) => c[0])).toEqual([state.c]);
  expect(state.load).toHaveBeenCalledWith(101);
});
it("tries the next source only when the newest lacks its exact required jobs", async () => {
  state.history.unshift(state.c);
  state.ci.unshift(run(state.c, 201));
  state.failedCi.add(state.c);
  await reconcileReleases();
  expect(state.qualification.mock.calls.map((c) => c[0])).toEqual([state.c, state.b]);
});
it("does not let an acceptance-report-only merge supersede the beta it certifies", async () => {
  state.history.unshift(state.c);
  state.ci.unshift(run(state.c, 201));
  state.acceptance.add(state.c);
  await reconcileReleases();
  expect(state.qualification.mock.calls.map((c) => c[0])).toEqual([state.b]);
});
it("checks only the pinned stable source and holds it in beta mode", async () => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "beta");
  state.intents = [pinned()];
  state.history.unshift(state.c);
  state.ci.unshift(run(state.c, 201));
  state.candidate = { ...state.candidate, kind: "stable" };
  await reconcileReleases();
  expect(state.qualification.mock.calls.map((c) => c[0])).toEqual([state.b]);
  expect(state.assemble).not.toHaveBeenCalled();
  expect(state.publish).not.toHaveBeenCalled();
});
it("fails visibly when the selected candidate build has failed instead of falling back", async () => {
  state.builds[0]!.conclusion = "failure";
  await expect(reconcileReleases()).rejects.toThrow("Candidate build is blocked");
  expect(state.load).not.toHaveBeenCalled();
});
it.each(["success", "failure"])(
  "verifies an already-public candidate after a %s rerun without loading expired artifacts",
  async (conclusion) => {
    state.builds[0]!.conclusion = conclusion;
    state.releases.push({
      tag_name: "v0.1.2-beta.1",
      draft: false,
      assets: [{ name: "f5-release-candidate.json" }],
    });
    await reconcileReleases();
    expect(state.verifyPublished).toHaveBeenCalledWith("v0.1.2-beta.1", state.b, 100);
    expect(state.load).not.toHaveBeenCalled();
    expect(JSON.parse(state.writes.get("release-summary.json")!).artifactDownloads).toBe(0);
  },
);
it("reuses the same verified shadow candidate across unrelated tip merges", async () => {
  state.cache = true;
  await reconcileReleases();
  state.history.unshift(state.c);
  await reconcileReleases();
  expect(state.assemble).not.toHaveBeenCalled();
  const keys = state.api.mock.calls
    .filter((c) => c[0].startsWith("actions/artifacts?"))
    .map((c) => c[0]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});
it("dispatches upgrade-only qualification once and waits for the matching pending run", async () => {
  state.changedBaselines = true;
  await reconcileReleases();
  expect(state.gh).toHaveBeenCalledTimes(1);
  expect(state.gh.mock.calls[0]![0]).toContain("candidate_run=100");
  state.proof = { ...run(state.b, 400), status: "in_progress", conclusion: null };
  await reconcileReleases();
  expect(state.gh).toHaveBeenCalledTimes(1);
  expect(state.assemble).not.toHaveBeenCalled();
});
it("reports failed upgrade proof jobs and reuses their successful rerun bound to the candidate", async () => {
  state.changedBaselines = true;
  state.proof = { ...run(state.b, 400), conclusion: "failure", run_attempt: 2 };
  await expect(reconcileReleases()).rejects.toThrow("Upgrade qualification is blocked");
  state.proof.conclusion = "success";
  await reconcileReleases();
  expect(state.assemble.mock.calls[0]![2]).toMatchObject({
    key: "100-1-baselines",
    requalification: { runId: 400, attempt: 2 },
  });
  expect(state.gh).not.toHaveBeenCalled();
});
it("blocks an expired proof instead of rebuilding or silently dispatching another candidate", async () => {
  state.changedBaselines = true;
  state.proof = { ...run(state.b, 400), run_attempt: 2 };
  state.proofMissing = true;
  await expect(reconcileReleases()).rejects.toThrow("missing/expired");
  expect(state.assemble).not.toHaveBeenCalled();
  expect(state.gh).not.toHaveBeenCalled();
});
it("refreshes stable intent before publication and blocks a newly merged barrier", async () => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "all");
  state.refreshedIntents = [{ ...pinned(), sourceSha: state.c }];
  await expect(reconcileReleases()).rejects.toThrow("stable request now holds");
  expect(state.assemble).toHaveBeenCalledOnce();
  expect(state.publish).not.toHaveBeenCalled();
});
it("rechecks the upgraded baselines after assembly before publication", async () => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "all");
  state.staleBaseline = true;
  await expect(reconcileReleases()).rejects.toThrow("baselines changed again");
  expect(state.publish).not.toHaveBeenCalled();
});
it("retains the last-moment publication gate after reconciliation", async () => {
  vi.stubEnv("RELEASE_AUTOMATION_MODE", "all");
  state.gate.mockImplementation(() => {
    throw new Error("newer passing source");
  });
  await expect(reconcileReleases()).rejects.toThrow("newer passing source");
  expect(state.gate).toHaveBeenCalledWith(state.candidate, "100-1-baselines");
});
