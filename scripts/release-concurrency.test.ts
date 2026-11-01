import { expect, it } from "vitest";
import { releasePool } from "./release/release-concurrency.ts";
import { intervalSeconds } from "./release/release-observability.ts";
import { jobTiming } from "./release/release-timing.ts";

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
