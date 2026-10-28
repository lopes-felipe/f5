import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { median } from "./lib/ci-test-sharding.ts";

export interface TimedJob {
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  steps: {
    name: string;
    conclusion: string | null;
    started_at: string;
    completed_at: string | null;
  }[];
}
const seconds = (start: string, end: string) =>
  Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));

export function jobTiming(job: TimedJob) {
  const setup = job.steps.find((step) => step.name === "Run ./.github/actions/setup");
  return {
    name: job.name,
    result: job.conclusion,
    queueSeconds: seconds(job.created_at, job.started_at),
    executionSeconds: job.completed_at ? seconds(job.started_at, job.completed_at) : null,
    setupSeconds:
      setup?.completed_at && setup.conclusion === "success"
        ? seconds(setup.started_at, setup.completed_at)
        : null,
  };
}

export function compareSetupPairs(jobs: readonly TimedJob[]) {
  const samples = { combined: [] as number[], "electron-only": [] as number[] };
  for (const mode of ["combined", "electron-only"] as const) {
    for (const pair of [1, 2, 3]) {
      const matches = jobs.filter((job) => job.name === "setup (" + pair + ", " + mode + ")");
      const timing = matches.length === 1 ? jobTiming(matches[0]!) : undefined;
      if (!timing || timing.result !== "success" || timing.setupSeconds === null)
        throw new Error("Missing or unsuccessful benchmark pair: " + pair + "/" + mode);
      samples[mode].push(timing.setupSeconds);
    }
  }
  const combined = median(samples.combined);
  const electronOnly = median(samples["electron-only"]);
  return {
    samples,
    medianSeconds: { combined, electronOnly },
    preferElectronOnly: electronOnly < combined,
  };
}

async function main() {
  const benchmark = process.argv[2] === "--benchmark";
  const runId = process.argv[benchmark ? 3 : 2];
  if (!runId || !/^[1-9]\d*$/.test(runId))
    throw new Error("Usage: node scripts/ci-run-timings.ts [--benchmark] <run-id> [attempt]");
  const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" });
  const repo =
    process.env.GITHUB_REPOSITORY ??
    JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner;
  const endpoint = "repos/" + repo + "/actions/runs/" + runId;
  const run = JSON.parse(gh("api", endpoint));
  const attempt = process.argv[benchmark ? 4 : 3] ?? String(run.run_attempt);
  if (!/^[1-9]\d*$/.test(attempt)) throw new Error("Invalid run attempt");
  const pages = JSON.parse(
    gh("api", "--paginate", "--slurp", endpoint + "/attempts/" + attempt + "/jobs"),
  );
  const jobs = (pages as { jobs: TimedJob[] }[]).flatMap((page) => page.jobs);
  const rows = jobs.filter((job) => job.conclusion !== "skipped").map(jobTiming);
  let markdown =
    "\nRun " +
    runId +
    ", attempt " +
    attempt +
    "\n\n| Job | Result | Queue (s) | Setup (s) | Execution including setup (s) |\n| --- | --- | ---: | ---: | ---: |\n" +
    rows
      .map(
        (row) =>
          "| " +
          [
            row.name,
            row.result,
            row.queueSeconds,
            row.setupSeconds ?? "—",
            row.executionSeconds ?? "—",
          ].join(" | ") +
          " |",
      )
      .join("\n") +
    "\n";
  if (benchmark) {
    const comparison = compareSetupPairs(jobs);
    markdown +=
      "\nMedian combined setup: " +
      comparison.medianSeconds.combined +
      "s; median Electron-only setup: " +
      comparison.medianSeconds.electronOnly +
      "s.\n\n" +
      (comparison.preferElectronOnly
        ? "Electron-only setup is faster in this sample. Compare cold and warm samples before changing the Windows default."
        : "Retain the separate Bun package cache; Electron-only setup did not win this sample.") +
      "\n";
  }
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
