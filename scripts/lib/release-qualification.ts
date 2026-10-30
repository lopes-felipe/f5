import { releaseProfilePlatforms, type ReleaseProfile } from "./release-profile.ts";
import { versionToken } from "@t3tools/shared/cliRelease";

/** Keep beta rehearsals on the beta feed while avoiding a publishable release version. */
export function dryRunReleaseVersion(current: string, runNumber: string): string {
  versionToken(current);
  if (!/^[1-9]\d*$/.test(runNumber)) throw new Error("Invalid dry-run number");
  return `${current}${current.includes("-") ? "." : "-"}dryrun.${runNumber}`;
}

export interface CiRun {
  id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  run_number: number;
}
export interface CiJob {
  name: string;
  conclusion: string | null;
  run_attempt?: number;
}
interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  needs?: string[];
  strategy?: { matrix?: Record<string, readonly (string | number)[]> };
}
export interface CiWorkflow {
  jobs: Record<string, WorkflowJob>;
}

export function selectReleaseCiRun(runs: readonly CiRun[], sha: string): CiRun {
  const latest = runs
    .filter((run) => run.head_branch === "main" && run.head_sha === sha && run.event === "push")
    .toSorted(
      (a, b) => b.run_number - a.run_number || b.id - a.id || b.run_attempt - a.run_attempt,
    )[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success")
    throw new Error("The latest main CI push run for the release SHA must succeed.");
  return latest;
}

/** Derive validation coverage from CI result and the platforms shipped by this release. */
export function requiredReleaseCiJobs(workflow: CiWorkflow, profile: ReleaseProfile): string[] {
  const platforms = releaseProfilePlatforms(profile);
  const required = workflow.jobs["ci-result"]?.needs;
  if (!required?.length) throw new Error("CI result must enumerate its validation jobs.");
  return [...required, "ci-result"].flatMap((id) => {
    const job = workflow.jobs[id];
    if (!job) throw new Error(`Missing CI validation job: ${id}`);
    if (job["runs-on"]?.startsWith("macos") && !platforms.includes("mac")) return [];
    if (job["runs-on"]?.startsWith("windows") && !platforms.includes("win")) return [];
    const name = job.name ?? id,
      matrix = job.strategy?.matrix;
    if (!matrix) return [name];
    let variants: (string | number)[][] = [[]];
    for (const [key, values] of Object.entries(matrix)) {
      if (!Array.isArray(values) || ["include", "exclude"].includes(key))
        throw new Error(`Unsupported release validation matrix: ${id}.${key}`);
      variants = variants.flatMap((variant) => values.map((value) => [...variant, value]));
    }
    return variants.map((variant) => `${name} (${variant.join(", ")})`);
  });
}
export function assertReleaseCiJobs(jobs: readonly CiJob[], expected: readonly string[]): void {
  const latest = new Map<string, CiJob>();
  for (const job of jobs)
    if ((latest.get(job.name)?.run_attempt ?? 0) <= (job.run_attempt ?? 1))
      latest.set(job.name, job);
  const missing = expected.filter((name) => latest.get(name)?.conclusion !== "success");
  if (missing.length)
    throw new Error(
      `Release validation jobs missing, skipped or unsuccessful: ${missing.join(", ")}`,
    );
}
