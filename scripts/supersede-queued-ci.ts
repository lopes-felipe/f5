import { pathToFileURL } from "node:url";
import { runGh, type Gh } from "./lib/github-cli.ts";
import { acceptanceOnlyFiles } from "./lib/release-source.ts";
import type { WorkflowRun } from "./release/release-github.ts";

interface CommitPage {
  files: { filename: string; previous_filename?: string }[];
  parents: { sha: string }[];
}

/** Supersede older main CI runs only while they are still observed queued. */
export async function supersedeQueuedCi(repository: string, gh: Gh = runGh): Promise<number[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const root = "repos/" + repository + "/";
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(await gh(["api", root + path])) as T;
  const pages = async <T>(path: string): Promise<T[]> =>
    JSON.parse(await gh(["api", "--paginate", "--slurp", root + path])) as T[];
  const trusted = (run: WorkflowRun) =>
    run.path === ".github/workflows/ci.yml" &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository.full_name === repository &&
    run.head_repository.full_name === repository &&
    /^[a-f0-9]{40}$/.test(run.head_sha);
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
    // Truncated diffs and true merges cannot prove that first-parent intent
    // changes are absent. Preserve those sources rather than infer eligibility.
    protectedSources.set(
      sha,
      commits.length === 0 ||
        files.length >= 3000 ||
        commits.some((commit) => commit.parents.length > 1) ||
        files.some(
          (file) =>
            file.filename === "release-intent.json" ||
            file.previous_filename === "release-intent.json",
        ),
    );
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
  }
  return cancelled;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  await supersedeQueuedCi(repository);
}
