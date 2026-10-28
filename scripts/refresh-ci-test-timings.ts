import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSchedulingDurations,
  medianDurations,
  reportArtifact,
  serverTestPath,
} from "./lib/ci-test-timings.ts";
import type { TestDurations } from "./lib/ci-test-sharding.ts";

// Explicit maintainer command only: CI never writes tracked timing data.
const runIds = process.argv.slice(2);
if (
  runIds.length < 3 ||
  new Set(runIds).size !== runIds.length ||
  runIds.some((id) => !/^[1-9]\d*$/.test(id))
)
  throw new Error(
    "Usage: bun scripts/refresh-ci-test-timings.ts <main-run-id> <main-run-id> <main-run-id> [...]",
  );
const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "apps/server");
const gh = (...args: string[]) => execFileSync("gh", args, { cwd: root, encoding: "utf8" });
const repo = JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner as string;
const expected = (
  JSON.parse(
    execFileSync(
      "node",
      ["node_modules/vitest/vitest.mjs", "list", "src", "--filesOnly", "--json"],
      { cwd: server, encoding: "utf8" },
    ),
  ) as { file: string }[]
).map((entry) => serverTestPath(entry.file));
const samples: Record<string, TestDurations[]> = { linux: [], win32: [] };
const sources: {
  repository: string;
  runId: number;
  attempt: number;
  sha: string;
  jobs: Record<string, number>;
}[] = [];
const shas = new Set<string>();
for (const runId of runIds) {
  const endpoint = "repos/" + repo + "/actions/runs/" + runId;
  const run = JSON.parse(gh("api", endpoint));
  if (
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.conclusion !== "success" ||
    run.path !== ".github/workflows/ci.yml"
  )
    throw new Error("Timing sources must be successful main push runs of CI");
  if (shas.has(run.head_sha)) throw new Error("Sources must contain distinct main commits");
  shas.add(run.head_sha);
  // The latest execution of each job can belong to an earlier run attempt when
  // only failed jobs were rerun. Never borrow an older result for a rerun job.
  const jobs = (
    JSON.parse(gh("api", "--paginate", "--slurp", endpoint + "/jobs?filter=latest")) as {
      jobs: { name: string; conclusion: string; run_attempt: number }[];
    }[]
  ).flatMap((page) => page.jobs);
  const artifacts = (
    JSON.parse(gh("api", "--paginate", "--slurp", endpoint + "/artifacts")) as {
      artifacts: { name: string; expired: boolean }[];
    }[]
  ).flatMap((page) => page.artifacts);
  const directory = mkdtempSync(join(tmpdir(), "f5-ci-timings-"));
  const attempts: Record<string, number> = {};
  try {
    for (const platform of ["linux", "win32"]) {
      const reports: unknown[] = [];
      const timings: unknown[] = [];
      const count = platform === "linux" ? 2 : 3;
      for (let index = 1; index <= count; index++) {
        const name =
          (platform === "linux" ? "server-unit" : "windows-server-unit") + " (" + index + ")";
        const matches = jobs.filter((job) => job.name === name);
        const job = matches[0];
        if (matches.length !== 1 || !job || job.conclusion !== "success")
          throw new Error("Missing, skipped or unsuccessful timing source job: " + name);
        attempts[name] = job.run_attempt;
        const selected = artifacts.filter((artifact) => {
          if (
            !artifact.name.startsWith("reports-server-unit-") &&
            !artifact.name.startsWith("reports-windows-server-unit-")
          )
            return false;
          const parsed = reportArtifact(artifact.name);
          return parsed.job === name && parsed.attempt === job.run_attempt && !artifact.expired;
        });
        if (selected.length !== 1)
          throw new Error(
            "Missing or duplicate artifact for " + name + ", attempt " + job.run_attempt,
          );
        const artifact = selected[0]!;
        gh(
          "run",
          "download",
          runId,
          "--repo",
          repo,
          "--dir",
          join(directory, artifact.name),
          "--name",
          artifact.name,
        );
      }
      function walk(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (
            /\/suites\/server-unit-\d+\/(?:results\.json|durations\.timings)$/.test(
              file.replaceAll("\\", "/"),
            )
          ) {
            const artifact = file.slice(directory.length).replaceAll("\\", "/").split("/")[1]!;
            if (reportArtifact(artifact).platform !== platform) continue;
            (entry.name === "results.json" ? reports : timings).push(
              JSON.parse(readFileSync(file, "utf8")),
            );
          }
        }
      }
      walk(directory);
      samples[platform]!.push(collectSchedulingDurations(reports, timings, expected));
    }
    const latest = JSON.parse(gh("api", endpoint));
    if (latest.run_attempt !== run.run_attempt || latest.conclusion !== "success")
      throw new Error("Source run changed while downloading reports");
    sources.push({
      repository: repo,
      runId: Number(runId),
      attempt: run.run_attempt,
      sha: run.head_sha,
      jobs: attempts,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const platforms = Object.fromEntries(
  Object.entries(samples).map(([platform, values]) => [
    platform,
    { sources, durationsMs: medianDurations(values) },
  ]),
);
writeFileSync(
  join(server, "test-timings.json"),
  JSON.stringify({ version: 1, enabled: true, platforms }, null, 2) + "\n",
);
console.log(
  "Enabled duration scheduling using median import-aware timings from " +
    runIds.length +
    " successful main runs.",
);
