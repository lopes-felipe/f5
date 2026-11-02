import { beforeEach, expect, it, vi } from "vitest";
import type { ReleaseCandidate, StableRequest } from "./release/release-candidate.ts";
import type { WorkflowRun } from "./release/release-github.ts";
const state = vi.hoisted(() => ({
  source: "a".repeat(40),
  newer: "b".repeat(40),
  failSource: false,
  failNewer: false,
  pending: [] as StableRequest[],
  key: "qualified",
  ci: [] as WorkflowRun[],
}));
vi.mock("./release/release-github.ts", () => ({
  repository: "lopes-felipe/f5",
  git: (args: string[]) =>
    args[1] === "--first-parent" ? [state.newer, state.source].join("\n") : state.newer,
  stableRequests: () => state.pending,
  requireCi: (sha: string) => {
    if ((sha === state.source && state.failSource) || (sha === state.newer && state.failNewer))
      throw new Error("latest required CI attempt is not green");
    return state.ci[0];
  },
  runs: () => state.ci,
  trustedRun: () => true,
  releaseProfileAt: () => "all",
  acceptanceOnlyCommit: () => false,
}));
vi.mock("./lib/release-profile.ts", () => ({ fetchReleaseSummaries: () => [] }));
vi.mock("./release/release-upgrade-proof.ts", () => ({ upgradePlan: () => ({ key: state.key }) }));
import { publicationGate } from "./release/release-publication-gate.ts";
const candidate = (): ReleaseCandidate =>
  ({
    sourceSha: state.source,
    kind: "beta",
    profile: "all",
  }) as ReleaseCandidate;
beforeEach(() => {
  state.failSource = state.failNewer = false;
  state.pending = [];
  state.key = "qualified";
  state.ci = [
    {
      id: 1,
      head_sha: state.newer,
      status: "completed",
      conclusion: "success",
      run_number: 1,
      run_attempt: 1,
    } as WorkflowRun,
  ];
});
it("blocks publication if the candidate's latest CI attempt regresses during upload", () => {
  state.failSource = true;
  expect(() => publicationGate(candidate(), "qualified")).toThrow("latest required CI");
});
it("blocks a newly qualified source after an older beta's upload", () => {
  expect(() => publicationGate(candidate(), "qualified")).toThrow("supersedes");
});
it("ignores newer sources without all required validation jobs", () => {
  state.failNewer = true;
  expect(() => publicationGate(candidate(), "qualified")).not.toThrow();
});
it("blocks a newly merged stable barrier and changed upgrade baselines", () => {
  state.pending = [
    { sourceSha: state.newer, version: "0.1.2", requestId: "00000000-0000-4000-8000-000000000001" },
  ];
  expect(() => publicationGate(candidate(), "qualified")).toThrow("holds publication");
  state.pending = [];
  state.key = "changed";
  expect(() => publicationGate(candidate(), "qualified")).toThrow("baselines changed");
});
