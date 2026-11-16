import { pathToFileURL } from "node:url";
import { runGh, type Gh } from "./lib/github-cli.ts";
import { protectsReleaseIntent, trustedMainCiRun, type CommitPage } from "./lib/main-ci-runs.ts";
import type { WorkflowRun } from "./release/release-github.ts";

export const MAX_CI_ATTEMPTS = 3;

interface Job {
  name: string;
  conclusion: string | null;
  steps?: unknown[];
}

const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * GitHub cancels a job it cannot assign to a hosted runner before any step runs. A run whose
 * only failures are such jobs has no test result at all, so rerunning it is always safe.
 */
export function onlyUnassignedJobsFailed(jobs: readonly Job[]): boolean {
  const failed = jobs.filter(
    (job) => job.name !== "CI result" && !PASSING.has(job.conclusion ?? ""),
  );
  return (
    failed.length > 0 &&
    failed.every((job) => job.conclusion === "cancelled" && (job.steps?.length ?? 0) === 0)
  );
}

/**
 * Rerun the current main CI run when GitHub never assigned runners to its failed jobs.
 * Stable release commits are left to the release publisher, which owns their retries.
 */
export async function rerunUnassignedCi(
  repository: string,
  runId: number | null,
  gh: Gh = runGh,
): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const root = "repos/" + repository + "/";
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(await gh(["api", root + path])) as T;
  const pages = async <T>(path: string): Promise<T[]> =>
    JSON.parse(await gh(["api", "--paginate", "--slurp", root + path])) as T[];

  const head = (await read<{ sha: string }>("commits/main")).sha;
  const run =
    runId === null
      ? (
          await read<{ workflow_runs: WorkflowRun[] }>(
            "actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=" +
              head +
              "&per_page=20",
          )
        ).workflow_runs
          .filter((candidate) => trustedMainCiRun(candidate, repository))
          .toSorted((a, b) => b.run_number - a.run_number || b.id - a.id)[0]
      : await read<WorkflowRun>("actions/runs/" + runId);
  if (!run) return "No CI run for main " + head;
  if (!trustedMainCiRun(run, repository)) return "Not a trusted main CI run: " + run.id;
  if (run.status !== "completed" || run.conclusion !== "failure")
    return `CI run ${run.id} is ${run.status}/${run.conclusion}`;
  if (run.run_attempt >= MAX_CI_ATTEMPTS)
    return `CI run ${run.id} already used ${run.run_attempt} of ${MAX_CI_ATTEMPTS} attempts`;
  // A newer commit's CI replaces this one; rerunning an older source only adds queue load.
  if (run.head_sha !== head) return `CI run ${run.id} is for ${run.head_sha}, not main ${head}`;
  if (protectsReleaseIntent(await pages<CommitPage>("commits/" + run.head_sha + "?per_page=100")))
    return `CI run ${run.id} may carry release intent; the release publisher retries it`;
  const jobs = (
    await pages<{ jobs: Job[] }>(
      "actions/runs/" + run.id + "/attempts/" + run.run_attempt + "/jobs?per_page=100",
    )
  ).flatMap((page) => page.jobs);
  if (!onlyUnassignedJobsFailed(jobs))
    return `CI run ${run.id} has failures that ran; leaving them for review`;
  // Re-read immediately before the POST so a manual rerun is not doubled.
  const current = await read<WorkflowRun>("actions/runs/" + run.id);
  if (current.run_attempt !== run.run_attempt || current.status !== "completed")
    return `CI run ${run.id} changed since it was read`;
  await gh(["api", "--method", "POST", root + "actions/runs/" + run.id + "/rerun-failed-jobs"]);
  return `Re-running unassigned jobs of CI run ${run.id} (attempt ${run.run_attempt + 1} of ${MAX_CI_ATTEMPTS})`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const runId = process.env.CI_RUN_ID ? Number(process.env.CI_RUN_ID) : null;
  if (runId !== null && !Number.isSafeInteger(runId)) throw new Error("Invalid CI_RUN_ID");
  console.log(await rerunUnassignedCi(repository, runId));
}
