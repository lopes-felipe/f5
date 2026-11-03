import { expect, it, vi } from "vitest";
import type { WorkflowRun } from "./release/release-github.ts";
import { releasePool } from "./release/release-concurrency.ts";
import { intervalSeconds } from "./release/release-observability.ts";
import { jobTiming, workflowTiming } from "./release/release-timing.ts";
const timingState = vi.hoisted(() => ({ gh: vi.fn() }));
vi.mock("./release/release-github.ts", () => ({
  repository: "fixture/f5",
  gh: timingState.gh,
  show: () => "jobs:\n  test: {}\n  result:\n    needs: test\n",
}));

it("bounds transfers, stops scheduling on failure, and drains active work", async () => {
  let active = 0,
    maximum = 0;
  const started: number[] = [],
    finished: number[] = [];
  const pending: (() => void)[] = [];
  const work = releasePool([0, 1, 2, 3, 4, 5], async (value) => {
    started.push(value);
    maximum = Math.max(maximum, ++active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active--;
    finished.push(value);
    if (value === 0) throw new Error("transfer interrupted");
  });
  const result = expect(work).rejects.toThrow("transfer interrupted");
  expect(started).toEqual([0, 1, 2]);
  pending[0]!();
  await Promise.resolve();
  await Promise.resolve();
  pending[1]!();
  pending[2]!();
  await result;
  expect(started).toEqual([0, 1, 2]);
  expect(finished.sort()).toEqual([0, 1, 2]);
  expect(active).toBe(0);
  expect(maximum).toBe(3);
});
it("counts overlapping phase intervals once and measures dependency-ready queueing", () => {
  expect(
    intervalSeconds([
      [0, 4000],
      [1000, 3000],
      [5000, 7000],
    ]),
  ).toBe(6);
  const time = (seconds: number) => new Date(seconds * 1000).toISOString();
  const jobs = [
    {
      name: "test",
      started_at: time(0),
      completed_at: time(10),
      steps: [{ started_at: time(2), completed_at: time(10) }],
    },
    {
      name: "result",
      started_at: time(10),
      completed_at: time(31),
      steps: [{ started_at: time(30), completed_at: time(31) }],
    },
  ];
  expect(jobTiming(jobs, time(0), { test: [], result: ["test"] })).toEqual([
    { name: "test", queueSeconds: 2, executionSeconds: 8 },
    { name: "result", queueSeconds: 20, executionSeconds: 1 },
  ]);
  expect(jobTiming(jobs, time(0), {})[0]!.queueSeconds).toBeNull();
});
it.each([
  { attempt: 1, started: 100, queue: 102 },
  { attempt: 2, started: 100, queue: 2 },
  { attempt: 2, started: null, queue: 102 },
])("measures queueing for attempt $attempt starting at $started", ({ attempt, started, queue }) => {
  const time = (seconds: number) => new Date(seconds * 1000).toISOString();
  timingState.gh.mockReset().mockReturnValue(
    JSON.stringify([
      {
        jobs: [
          {
            name: "test",
            started_at: time(100),
            completed_at: time(110),
            steps: [{ started_at: time(102), completed_at: time(110) }],
          },
          {
            name: "result",
            started_at: time(110),
            completed_at: time(131),
            steps: [{ started_at: time(130), completed_at: time(131) }],
          },
        ],
      },
    ]),
  );
  const run = {
    id: 10,
    run_attempt: attempt,
    head_sha: "a".repeat(40),
    path: ".github/workflows/ci.yml",
    created_at: time(0),
    run_started_at: started === null ? undefined : time(started),
  } as WorkflowRun;
  expect(workflowTiming(run)).toEqual([
    { name: "test", queueSeconds: queue, executionSeconds: 8 },
    { name: "result", queueSeconds: 20, executionSeconds: 1 },
  ]);
  expect(timingState.gh.mock.calls[0]![0].at(-1)).toContain("/attempts/" + attempt + "/jobs?");
});
