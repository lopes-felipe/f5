import { pathToFileURL } from "node:url";
import { runGh, type Gh } from "./lib/github-cli.ts";
import { acceptanceOnlyFiles } from "./lib/release-source.ts";
import {
  protectsReleaseIntent,
  trustedMainCiRun,
  trustedMainPushRun,
  type CommitPage,
} from "./lib/main-ci-runs.ts";
import type { WorkflowRun } from "./release/release-github.ts";

/**
 * Supersede older main CI runs only while they are still observed queued, together
 * with the release candidates of the same commits.
 */
export async function supersedeQueuedCi(repository: string, gh: Gh = runGh): Promise<number[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const root = "repos/" + repository + "/";
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(await gh(["api", root + path])) as T;
  const pages = async <T>(path: string): Promise<T[]> =>
    JSON.parse(await gh(["api", "--paginate", "--slurp", root + path])) as T[];
  const trusted = (run: WorkflowRun) => trustedMainCiRun(run, repository);
  const workflow = "actions/workflows/ci.yml/runs?branch=main&event=push&";
  const newestRuns = (await read<{ workflow_runs: WorkflowRun[] }>(workflow + "per_page=100"))
    .workflow_runs;
  const newest = newestRuns.find(trusted);
  if (!newest) return [];
  const queued = await pages<{ total_count: number; workflow_runs: WorkflowRun[] }>(
    workflow + "status=queued&per_page=100",
  );
  if (queued.some((page) => page.total_count >= 1000))
    throw new Error("Too many queued CI runs to supersede safely");
  const cancelled: number[] = [];
  const protectedSources = new Map<string, boolean>();
  const commitFiles = new Map<string, CommitPage["files"]>();
  const readCommit = async (sha: string): Promise<CommitPage["files"]> => {
    const cached = commitFiles.get(sha);
    if (cached) return cached;
    const commits = await pages<CommitPage>("commits/" + sha + "?per_page=100");
    const files = commits.flatMap((commit) => commit.files);
    protectedSources.set(sha, protectsReleaseIntent(commits));
    commitFiles.set(sha, files);
    return files;
  };
  let replacementRun: WorkflowRun | undefined;
  let replacementChecked = false;
  const eligibleReplacement = async (): Promise<WorkflowRun | undefined> => {
    if (replacementChecked) return replacementRun;
    replacementChecked = true;
    for (const candidate of newestRuns) {
      if (!trusted(candidate)) continue;
      const files = await readCommit(candidate.head_sha);
      if (protectedSources.get(candidate.head_sha)) continue;
      if (
        acceptanceOnlyFiles(
          files.flatMap((file) => [
            file.filename,
            ...(file.previous_filename ? [file.previous_filename] : []),
          ]),
        )
      )
        continue;
      if (candidate.status === "completed" && candidate.conclusion !== "success") return undefined;
      replacementRun = candidate;
      return candidate;
    }
    return undefined;
  };
  // Publication needs a green main CI run for the exact commit. Once GitHub has
  // accepted that run's cancellation the commit's candidate cannot publish, so its
  // packaging jobs (three of them on macOS) only take runners from newer commits. The
  // caller has already established that the commit carries no release intent and has
  // a newer replacement. A CI run whose jobs were all still unassigned was never
  // green, so the publisher cannot have selected this source; only a manual rerun of
  // an already qualified source could make that untrue, and the identity re-read
  // below leaves a candidate alone when its attempt changed under us.
  // `settled` holds candidates already dealt with, so a retry does not POST to a run
  // that is still winding down from an accepted cancellation.
  const cancelCandidates = async (sha: string, settled: Set<number>): Promise<void> => {
    const candidates = await read<{ workflow_runs: WorkflowRun[] }>(
      "actions/workflows/release.yml/runs?branch=main&event=push&head_sha=" + sha + "&per_page=100",
    );
    for (const candidate of candidates.workflow_runs) {
      if (
        settled.has(candidate.id) ||
        !trustedMainPushRun(candidate, repository, "release.yml") ||
        candidate.head_sha !== sha ||
        candidate.status === "completed"
      )
        continue;
      // Re-read mutable identity immediately before the cancellation request, as
      // the Release coordinator does.
      const current = await read<WorkflowRun>("actions/runs/" + candidate.id);
      if (
        !trustedMainPushRun(current, repository, "release.yml") ||
        current.id !== candidate.id ||
        current.head_sha !== sha ||
        current.run_attempt !== candidate.run_attempt ||
        current.status === "completed"
      )
        continue;
      try {
        await gh(["api", "--method", "POST", root + "actions/runs/" + candidate.id + "/cancel"]);
      } catch (error) {
        // Completion racing cancellation is success; other failures stay visible.
        if ((await read<WorkflowRun>("actions/runs/" + candidate.id)).status !== "completed")
          throw error;
        settled.add(candidate.id);
        continue;
      }
      settled.add(candidate.id);
      console.log("Cancelled release candidate run", candidate.id, "of superseded source", sha);
    }
  };
  // A superseded source's CI run has left the queue, so no later invocation looks at
  // its candidate again. Retry once here, and never let one source's candidate stop
  // the sweep: the remaining queued runs are still superseded before the failure is
  // reported.
  const candidateFailures: { sha: string; error: unknown }[] = [];
  const cancelCandidatesOrRecord = async (sha: string): Promise<void> => {
    const settled = new Set<number>();
    for (let attempt = 1; ; attempt++) {
      try {
        await cancelCandidates(sha, settled);
        return;
      } catch (error) {
        if (attempt === 1) {
          console.warn("Release candidate cleanup failed for", sha + "; retrying once:", error);
          continue;
        }
        candidateFailures.push({ sha, error });
        return;
      }
    }
  };
  for (const run of new Map(
    queued.flatMap((page) => page.workflow_runs).map((run) => [run.id, run]),
  ).values()) {
    if (
      !trusted(run) ||
      run.status !== "queued" ||
      run.run_number >= newest.run_number ||
      run.head_sha === newest.head_sha
    )
      continue;
    await readCommit(run.head_sha);
    if (protectedSources.get(run.head_sha)) continue;
    const replacement = await eligibleReplacement();
    if (
      !replacement ||
      run.run_number >= replacement.run_number ||
      run.head_sha === replacement.head_sha
    )
      continue;
    const comparison = await read<{ status: string }>(
      "compare/" + run.head_sha + "..." + replacement.head_sha + "?per_page=1",
    );
    if (comparison.status !== "ahead") continue;
    const jobs = await pages<{ jobs: { status: string; runner_id: number | null }[] }>(
      "actions/runs/" + run.id + "/jobs?per_page=100",
    );
    if (
      jobs.some((page) => page.jobs.some((job) => job.status !== "queued" || job.runner_id !== 0))
    )
      continue;
    // Re-read mutable identity immediately before the cancellation request.
    // GitHub has no conditional queued-only cancel; a start can still race the POST.
    const current = await read<WorkflowRun>("actions/runs/" + run.id);
    if (
      !trusted(current) ||
      current.id !== run.id ||
      current.head_sha !== run.head_sha ||
      current.run_attempt !== run.run_attempt ||
      current.status !== "queued"
    )
      continue;
    try {
      await gh(["api", "--method", "POST", root + "actions/runs/" + run.id + "/cancel"]);
    } catch (error) {
      // A run may leave the queue while the request is in flight.
      if ((await read<WorkflowRun>("actions/runs/" + run.id)).status === "queued") throw error;
      continue;
    }
    cancelled.push(run.id);
    console.log("Superseded queued main CI run", run.id, "with", replacement.id);
    await cancelCandidatesOrRecord(run.head_sha);
  }
  if (candidateFailures.length)
    throw new AggregateError(
      candidateFailures.map((failure) => failure.error),
      "Superseded main CI runs " +
        (cancelled.join(", ") || "none") +
        ", but release candidates of " +
        candidateFailures.map((failure) => failure.sha).join(", ") +
        " are still running. Cancel them with gh run cancel <candidate-run-id>. Causes: " +
        candidateFailures.map((failure) => String(failure.error)).join("; "),
    );
  return cancelled;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  await supersedeQueuedCi(repository);
}
