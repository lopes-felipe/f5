import { expect, it } from "vitest";
import { compareSetupPairs, jobTiming, runTimingSummary, type TimedJob } from "./ci-run-timings.ts";

function job(name: string, duration: number): TimedJob {
  return {
    name,
    run_attempt: 1,
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
    job("setup (" + pair + ", split)", 80 + pair),
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
    medianSeconds: { combined: 102, split: 82, electronOnly: 42 },
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
it("counts cache-save time when choosing the winning layout", () => {
  const values = pairs();
  for (const sample of values.filter((value) => value.name.includes("electron-only"))) {
    sample.steps.push({
      name: "Post Run ./.github/actions/setup",
      conclusion: "success",
      started_at: "2026-10-28T00:08:00Z",
      completed_at: "2026-10-28T00:10:00Z",
    });
  }
  expect(jobTiming(values[2]!)).toMatchObject({ cacheSaveSeconds: 120, setupSeconds: 161 });
  expect(compareSetupPairs(values).preferElectronOnly).toBe(false);
});
it("retains the timing table when a failed or missing sample prevents comparison", () => {
  const values = pairs().slice(1);
  for (const sample of values) sample.run_attempt = 2;
  values[0]!.conclusion = "failure";
  const summary = runTimingSummary("123", "2", values, true);
  expect(summary.valid).toBe(false);
  expect(summary.markdown).toContain("| setup (1, split) | failure |");
  expect(summary.markdown).toContain("attempt 2");
  expect(summary.markdown).toContain("Benchmark comparison unavailable:");
});
it("does not present inherited jobs as new rerun samples", () => {
  const inherited = job("setup (1, combined)", 100);
  const rerun = { ...job("setup (1, electron-only)", 40), run_attempt: 2 };
  const summary = runTimingSummary("123", "2", [inherited, rerun], true);
  expect(summary.valid).toBe(false);
  expect(summary.markdown).not.toContain("| setup (1, combined) |");
  expect(summary.markdown).toContain("| setup (1, electron-only) |");
  expect(summary.markdown).toContain("setup (1, combined) (attempt 1)");
});
