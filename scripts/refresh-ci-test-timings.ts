import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTestDurations, serverTestPath } from "./lib/ci-test-timings.ts";

// Explicit maintainer command only: CI never writes tracked timing data.
const runId = process.argv[2];
if (!runId || !/^[1-9]\d*$/.test(runId))
  throw new Error("Usage: bun scripts/refresh-ci-test-timings.ts <successful-main-run-id>");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "apps/server");
const gh = (...args: string[]) => execFileSync("gh", args, { cwd: root, encoding: "utf8" });
const repo = JSON.parse(gh("repo", "view", "--json", "nameWithOwner")).nameWithOwner as string;
const run = JSON.parse(gh("api", "repos/" + repo + "/actions/runs/" + runId)) as {
  event: string;
  head_branch: string;
  head_sha: string;
  conclusion: string;
  run_attempt: number;
  path: string;
};
if (
  run.event !== "push" ||
  run.head_branch !== "main" ||
  run.conclusion !== "success" ||
  run.path !== ".github/workflows/ci.yml"
)
  throw new Error("Timing sources must be successful main push runs of CI");
const expected = (
  JSON.parse(
    execFileSync(
      "node",
      ["node_modules/vitest/vitest.mjs", "list", "src", "--filesOnly", "--json"],
      { cwd: server, encoding: "utf8" },
    ),
  ) as { file: string }[]
).map((entry) => serverTestPath(entry.file));
const directory = mkdtempSync(join(tmpdir(), "f5-ci-timings-"));
try {
  gh(
    "run",
    "download",
    runId,
    "--repo",
    repo,
    "--dir",
    directory,
    "--pattern",
    "reports-server-unit-Linux-*-" + run.run_attempt,
    "--pattern",
    "reports-windows-server-unit-Windows-*-" + run.run_attempt,
    "--pattern",
    "reports-macos-suite-macOS-*-" + run.run_attempt,
  );
  const reports: Record<string, unknown[]> = { linux: [], win32: [], darwin: [] };
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\/suites\/server-unit(?:-\d+)?\/results\.json$/.test(file.replaceAll("\\", "/"))) {
        const artifact = file.slice(directory.length).replaceAll("\\", "/").split("/")[1]!;
        const platform = artifact.includes("-Linux-")
          ? "linux"
          : artifact.includes("-Windows-")
            ? "win32"
            : "darwin";
        reports[platform]!.push(JSON.parse(readFileSync(file, "utf8")));
      }
    }
  }
  walk(directory);
  const latest = JSON.parse(gh("api", "repos/" + repo + "/actions/runs/" + runId));
  if (latest.run_attempt !== run.run_attempt || latest.conclusion !== "success")
    throw new Error("Source run changed while downloading reports");
  const platforms = Object.fromEntries(
    Object.entries(reports).map(([platform, values]) => [
      platform,
      {
        source: {
          repository: repo,
          runId: Number(runId),
          attempt: run.run_attempt,
          sha: run.head_sha,
        },
        durationsMs: collectTestDurations(values, expected),
      },
    ]),
  );
  writeFileSync(
    join(server, "test-timings.json"),
    JSON.stringify({ version: 1, platforms }, null, 2) + "\n",
  );
  console.log("Refreshed all platform timings from successful main run " + runId);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
