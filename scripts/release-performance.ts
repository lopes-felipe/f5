// @effect-diagnostics nodeBuiltinImport:off
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  api,
  gh,
  git,
  readArtifactJson,
  repository,
  type RemoteArtifact,
  type WorkflowRun,
} from "./release/release-github.ts";
import { SHA_PATTERN } from "./release/release-candidate.ts";

export interface ReleaseSample {
  version: string;
  sourceSha: string;
  publishedAt: string;
  seconds: number;
  summaryRun: number;
  jobTimings?: unknown;
  phaseSeconds?: unknown;
}
export function performanceResult(samples: readonly ReleaseSample[]) {
  const first = [
    ...new Map(
      samples
        .toSorted((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
        .map((sample) => [sample.version, sample] as const),
    ).values(),
  ].slice(0, 3);
  const durations = first.map((sample) => sample.seconds).sort((a, b) => a - b);
  const median = first.length === 3 ? durations[1]! : null;
  return {
    status: median === null ? "waiting-for-samples" : median <= 1500 ? "met" : "unmet",
    targetSeconds: 1500,
    medianSeconds: median,
    samples: first,
    nextAction:
      median !== null && median > 1500
        ? "Keep the performance milestone open; use jobTimings and phaseSeconds to propose capacity or critical-path changes. Do not purchase runners or relax gates."
        : null,
  };
}
export async function releasePerformance(
  since: string,
): Promise<ReturnType<typeof performanceResult>> {
  if (!SHA_PATTERN.test(since)) throw new Error("--since requires the hardening merge's full SHA");
  git(["fetch", "origin", "main", "--tags"]);
  const history = git(["rev-list", "--first-parent", "origin/main"]).split("\n").toReversed();
  const index = history.indexOf(since);
  if (index < 0) throw new Error("Hardening SHA is not on main's first-parent history");
  const eligible = new Set(history.slice(index));
  const records = (
    JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/" +
          repository +
          "/actions/workflows/release-publish.yml/runs?branch=main&per_page=100",
      ]),
    ) as { workflow_runs: WorkflowRun[] }[]
  )
    .flatMap((page) => page.workflow_runs)
    .filter(
      (run) =>
        ["workflow_run", "schedule"].includes(run.event) &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.path === ".github/workflows/release-publish.yml" &&
        run.head_branch === "main" &&
        run.repository.full_name === repository &&
        run.head_repository.full_name === repository,
    )
    .toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const samples: ReleaseSample[] = [];
  for (const run of records) {
    if (!eligible.has(run.head_sha)) continue;
    const artifact = api<{ artifacts: RemoteArtifact[] }>(
      "actions/runs/" + run.id + "/artifacts",
    ).artifacts.find((a) => a.name === "release-summary-" + run.id + "-" + run.run_attempt);
    if (!artifact || artifact.expired)
      throw new Error("Performance evidence missing or expired for publisher " + run.id);
    const summary = await readArtifactJson<{
      status: string;
      mode: string;
      version: string;
      sourceSha: string;
      jobTimings?: unknown;
      phaseSeconds?: unknown;
    }>(artifact, "release-summary.json");
    if (
      summary.status !== "published" ||
      !["beta", "all"].includes(summary.mode ?? "") ||
      !eligible.has(summary.sourceSha) ||
      !/^\d+\.\d+\.\d+-beta\.\d+$/.test(summary.version)
    )
      continue;
    const release = api<{
      draft: boolean;
      prerelease: boolean;
      immutable: boolean;
      published_at: string;
    }>("releases/tags/v" + summary.version);
    if (
      release.draft ||
      !release.prerelease ||
      !release.immutable ||
      git(["rev-list", "-n", "1", "v" + summary.version]) !== summary.sourceSha
    )
      throw new Error("Performance sample release identity mismatch");
    const merged = api<{ commit: { committer: { date: string } } }>("commits/" + summary.sourceSha);
    const seconds = Math.round(
      (Date.parse(release.published_at) - Date.parse(merged.commit.committer.date)) / 1000,
    );
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid publication timestamps");
    samples.push({
      version: summary.version,
      sourceSha: summary.sourceSha,
      publishedAt: release.published_at,
      seconds,
      summaryRun: run.id,
      jobTimings: summary.jobTimings,
      phaseSeconds: summary.phaseSeconds,
    });
    if (new Set(samples.map((sample) => sample.version)).size >= 3) break;
  }
  return performanceResult(samples);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { since: { type: "string" } } });
  const result = await releasePerformance(values.since ?? "");
  const json = JSON.stringify(result, null, 2) + "\n";
  writeFileSync("release-performance.json", json);
  console.log(json);
}
