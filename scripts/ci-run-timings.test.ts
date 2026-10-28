import { expect, it } from "vitest";
import { compareSetupPairs, jobTiming, type TimedJob } from "./ci-run-timings.ts";

function job(name: string, duration: number): TimedJob {
  return {
    name,
    conclusion: "success",
    created_at: "2026-10-28T00:00:00Z",
    started_at: "2026-10-28T00:01:00Z",
    completed_at: "2026-10-28T00:10:00Z",
    steps: [
      {
        name: "Run ./.github/actions/setup",
        conclusion: "success",
        started_at: "2026-10-28T00:01:00Z",
        completed_at: new Date(Date.parse("2026-10-28T00:01:00Z") + duration * 1000).toISOString(),
      },
    ],
  };
}
const pairs = () =>
  [1, 2, 3].flatMap((pair) => [
    job("setup (" + pair + ", combined)", 100 + pair),
    job("setup (" + pair + ", electron-only)", 40 + pair),
  ]);

it("separates queueing, setup and total execution", () => {
  expect(jobTiming(job("test", 120))).toMatchObject({
    queueSeconds: 60,
    setupSeconds: 120,
    executionSeconds: 540,
  });
});
it("compares exactly three successful pairs using median total setup time", () => {
  expect(compareSetupPairs(pairs())).toMatchObject({
    medianSeconds: { combined: 102, electronOnly: 42 },
    preferElectronOnly: true,
  });
  const slower = pairs().map((value) =>
    value.name.includes("electron-only") ? job(value.name, 150) : value,
  );
  expect(compareSetupPairs(slower).preferElectronOnly).toBe(false);
});
it("rejects missing, duplicate, failed and unfinished benchmark pairs", () => {
  expect(() => compareSetupPairs(pairs().slice(1))).toThrow("pair");
  expect(() => compareSetupPairs([...pairs(), pairs()[0]!])).toThrow("pair");
  for (const conclusion of ["failure", "cancelled", null]) {
    const values = pairs();
    values[0]!.conclusion = conclusion;
    expect(() => compareSetupPairs(values)).toThrow("pair");
  }
});
