import { describe, expect, it, vi } from "vitest";
import { assertReleaseCi } from "./lib/release-ci.ts";

const run = {
  id: 20,
  head_sha: "release-sha",
  event: "push",
  status: "completed",
  conclusion: "success",
  run_attempt: 2,
  created_at: "2026-10-19T00:00:00Z",
};
const gate = { name: "CI result", status: "completed", conclusion: "success" };
function fixture(overrides: Record<string, unknown> = {}) {
  const base = "repos/example/f5/actions";
  const routes: Record<string, unknown> = {
    [`${base}/workflows/ci.yml/runs?head_sha=release-sha&event=push&per_page=100`]: {
      workflow_runs: [run],
    },
    [`${base}/runs/20`]: run,
    [`${base}/runs/20/attempts/2`]: run,
    [`${base}/runs/20/attempts/2/jobs?per_page=100&page=1`]: { total_count: 1, jobs: [gate] },
    ...overrides,
  };
  const api = vi.fn((path: string): unknown => {
    if (!(path in routes)) throw new Error(`Unexpected API call ${path}`);
    return routes[path];
  });
  const git = vi.fn((args: string[]) => (args[0] === "rev-parse" ? "release-sha" : ""));
  return { api, git, check: () => assertReleaseCi({ repository: "example/f5", git, api }) };
}
describe("exact-SHA release CI", () => {
  it("requires the exact commit's successful latest attempt and gate", () => {
    const test = fixture();
    test.check();
    expect(test.git).toHaveBeenCalledWith([
      "merge-base",
      "--is-ancestor",
      "release-sha",
      "origin/main",
    ]);
    expect(test.api.mock.calls.every(([path]) => !path.includes("status=success"))).toBe(true);
  });
  it.each([
    { status: "queued", conclusion: null },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "cancelled" },
  ])("rejects a latest rerun with $status/$conclusion even after a green attempt", (state) => {
    expect(() =>
      fixture({ "repos/example/f5/actions/runs/20": { ...run, ...state } }).check(),
    ).toThrow("Latest CI push attempt");
  });
  it("selects the newest run instead of an older success", () => {
    const test = fixture({
      "repos/example/f5/actions/workflows/ci.yml/runs?head_sha=release-sha&event=push&per_page=100":
        {
          workflow_runs: [{ ...run, id: 19, created_at: "2026-10-18T00:00:00Z" }, run],
        },
      "repos/example/f5/actions/runs/20": { ...run, status: "in_progress", conclusion: null },
    });
    expect(test.check).toThrow("Latest CI push attempt");
  });
  it.each(
    [[], [{ ...run, head_sha: "other-sha" }], [{ ...run, event: "workflow_dispatch" }]].map(
      (workflow_runs) => ({ workflow_runs }),
    ),
  )("rejects missing exact-SHA push runs", ({ workflow_runs }) => {
    expect(() =>
      fixture({
        "repos/example/f5/actions/workflows/ci.yml/runs?head_sha=release-sha&event=push&per_page=100":
          { workflow_runs },
      }).check(),
    ).toThrow("exact release SHA");
  });
  it.each(
    [
      [],
      [{ ...gate, conclusion: "skipped" }],
      [{ ...gate, conclusion: "failure" }],
      [gate, gate],
    ].map((jobs) => ({ jobs })),
  )("rejects missing, skipped, failed and duplicate gates", ({ jobs }) => {
    expect(() =>
      fixture({
        "repos/example/f5/actions/runs/20/attempts/2/jobs?per_page=100&page=1": {
          total_count: jobs.length,
          jobs,
        },
      }).check(),
    ).toThrow("CI result gate");
  });
  it("reads every jobs page from the latest attempt", () => {
    const test = fixture({
      "repos/example/f5/actions/runs/20/attempts/2/jobs?per_page=100&page=1": {
        total_count: 101,
        jobs: Array.from({ length: 100 }, (_, i) => ({ ...gate, name: `job ${i}` })),
      },
      "repos/example/f5/actions/runs/20/attempts/2/jobs?per_page=100&page=2": {
        total_count: 101,
        jobs: [gate],
      },
    });
    test.check();
    expect(test.api).toHaveBeenCalledWith(expect.stringContaining("page=2"));
  });
  it.each([
    { ...run, status: "in_progress", conclusion: null },
    { ...run, conclusion: "failure" },
    { ...run, run_attempt: 1 },
  ])("rejects an unsuccessful or mismatched attempt response", (attempt) => {
    expect(() =>
      fixture({ "repos/example/f5/actions/runs/20/attempts/2": attempt }).check(),
    ).toThrow(/Latest CI push attempt|CI attempt changed/);
  });
  it.each([{ total_count: 0, jobs: [gate] }, { total_count: 1, jobs: [] }, { total_count: 1 }])(
    "rejects malformed or incomplete job inventories",
    (response) => {
      expect(() =>
        fixture({
          "repos/example/f5/actions/runs/20/attempts/2/jobs?per_page=100&page=1": response,
        }).check(),
      ).toThrow("Malformed or incomplete CI jobs response");
    },
  );
  it("fails closed on API errors, malformed responses and ancestry errors", () => {
    const test = fixture();
    test.api.mockImplementation(() => {
      throw new Error("API unavailable");
    });
    expect(test.check).toThrow("API unavailable");
    expect(() => fixture({ "repos/example/f5/actions/runs/20": {} }).check()).toThrow("Malformed");
    const ancestry = fixture();
    ancestry.git.mockImplementation(() => {
      throw new Error("not an ancestor");
    });
    expect(ancestry.check).toThrow("not an ancestor");
    expect(ancestry.api).not.toHaveBeenCalled();
  });
  it("rejects a rerun that starts while jobs are being read", () => {
    const test = fixture();
    const original = test.api.getMockImplementation()!;
    let reads = 0;
    test.api.mockImplementation((path) =>
      path.endsWith("/runs/20") && ++reads === 2
        ? { ...run, run_attempt: 3, status: "in_progress", conclusion: null }
        : original(path),
    );
    expect(test.check).toThrow("Latest CI push attempt");
  });
});
