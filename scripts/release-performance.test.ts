import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  expired: false,
  event: "schedule",
  trusted: true,
  reads: 0,
  mode: "beta",
  version: "0.1.2-beta.1",
}));
vi.mock("./release/release-github.ts", () => ({
  repository: "fixture/f5",
  git: (args: string[]) => (args[0] === "fetch" ? "" : "a".repeat(40)),
  gh: () =>
    JSON.stringify([
      {
        workflow_runs: [
          {
            id: 10,
            event: state.event,
            status: "completed",
            conclusion: "success",
            path: ".github/workflows/release-publish.yml",
            head_branch: "main",
            head_sha: "a".repeat(40),
            run_attempt: 1,
            created_at: new Date(0).toISOString(),
            repository: { full_name: "fixture/f5" },
            head_repository: { full_name: state.trusted ? "fixture/f5" : "attacker/fork" },
          },
        ],
      },
    ]),
  api: (path: string) => {
    if (path.includes("/artifacts"))
      return { artifacts: [{ name: "release-summary-10-1", expired: state.expired }] };
    if (path.startsWith("commits/"))
      return { commit: { committer: { date: new Date(0).toISOString() } } };
    return {
      draft: false,
      prerelease: true,
      immutable: true,
      published_at: new Date(1200000).toISOString(),
    };
  },
  readArtifactJson: async () => {
    state.reads++;
    return {
      status: "published",
      mode: state.mode,
      sourceSha: "a".repeat(40),
      version: state.version,
    };
  },
}));
import {
  performanceResult,
  releasePerformance,
  type ReleaseSample,
} from "./release-performance.ts";
beforeEach(() => {
  state.expired = false;
  state.event = "schedule";
  state.trusted = true;
  state.reads = 0;
  state.mode = "beta";
  state.version = "0.1.2-beta.1";
});
afterEach(() => vi.restoreAllMocks());
const sample = (index: number, seconds: number): ReleaseSample => ({
  version: "0.1.2-beta." + index,
  sourceSha: "a".repeat(40),
  summaryRun: index,
  publishedAt: new Date(index * 1000).toISOString(),
  seconds,
});
it("requires three routine samples and keeps the earliest consecutive releases", () => {
  expect(performanceResult([sample(1, 1200)]).status).toBe("waiting-for-samples");
  const result = performanceResult([
    sample(4, 900),
    sample(2, 1800),
    sample(1, 1200),
    sample(3, 1500),
    sample(2, 1800),
  ]);
  expect(result.samples.map((s) => s.version)).toEqual([
    "0.1.2-beta.1",
    "0.1.2-beta.2",
    "0.1.2-beta.3",
  ]);
  expect(result.medianSeconds).toBe(1500);
  expect(result.status).toBe("met");
});
it("leaves missed performance targets explicit with a capacity follow-up", () => {
  const result = performanceResult([sample(1, 1800), sample(2, 1900), sample(3, 1200)]);
  expect(result.status).toBe("unmet");
  expect(result.medianSeconds).toBe(1800);
  expect(result.nextAction).toContain("Do not purchase runners or relax gates");
});
it("counts scheduled unattended publication using independently read public timestamps", async () => {
  const result = await releasePerformance("a".repeat(40));
  expect(result.samples[0]!.seconds).toBe(1200);
  expect(state.reads).toBe(1);
});
it.each(["manual", "untrusted"])(
  "excludes %s publication from routine measurements",
  async (kind) => {
    if (kind === "manual") state.event = "workflow_dispatch";
    else state.trusted = false;
    expect((await releasePerformance("a".repeat(40))).samples).toEqual([]);
    expect(state.reads).toBe(0);
  },
);
it("blocks performance claims when required summary evidence has expired", async () => {
  state.expired = true;
  await expect(releasePerformance("a".repeat(40))).rejects.toThrow("missing or expired");
});
it("counts routine betas in all mode after stable automation is enabled", async () => {
  state.mode = "all";
  expect((await releasePerformance("a".repeat(40))).samples).toHaveLength(1);
});
it.each(["shadow", "stable"])("excludes %s from routine beta measurements", async (kind) => {
  if (kind === "shadow") state.mode = "shadow";
  else {
    state.mode = "all";
    state.version = "0.1.2";
  }
  expect((await releasePerformance("a".repeat(40))).samples).toEqual([]);
});
