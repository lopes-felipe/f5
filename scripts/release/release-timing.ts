import { gh, repository, show, type WorkflowRun } from "./release-github.ts";
import { parse } from "yaml";

export interface TimedJob {
  name: string;
  started_at: string;
  completed_at: string | null;
  steps: { started_at: string; completed_at: string | null }[];
}
/** Dependency-ready queue time is an estimate where reusable job names cannot be resolved. */
export function jobTiming(
  jobs: readonly TimedJob[],
  createdAt: string,
  needs: Record<string, readonly string[]>,
): { name: string; queueSeconds: number | null; executionSeconds: number | null }[] {
  const parseTime = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);
  return jobs.map((job) => {
    const start = parseTime(job.steps[0]?.started_at);
    const end = parseTime(job.completed_at);
    const dependencies = needs[job.name];
    const completions = dependencies?.map((name) =>
      parseTime(jobs.find((j) => j.name === name)?.completed_at),
    );
    const ready =
      completions && completions.every(Number.isFinite)
        ? Math.max(parseTime(createdAt), ...completions)
        : NaN;
    return {
      name: job.name,
      queueSeconds:
        Number.isFinite(start) && Number.isFinite(ready)
          ? Math.max(0, Math.round((start - ready) / 1000))
          : null,
      executionSeconds:
        Number.isFinite(start) && Number.isFinite(end)
          ? Math.max(0, Math.round((end - start) / 1000))
          : null,
    };
  });
}
export function workflowTiming(run: WorkflowRun): ReturnType<typeof jobTiming> {
  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      "repos/" +
        repository +
        "/actions/runs/" +
        run.id +
        "/attempts/" +
        run.run_attempt +
        "/jobs?per_page=100",
    ]),
  ) as { jobs: TimedJob[] }[];
  const workflow = parse(show(run.head_sha, run.path) ?? "") as {
    jobs?: Record<
      string,
      { name?: string; needs?: string | string[]; strategy?: { matrix?: Record<string, unknown> } }
    >;
  } | null;
  const jobs = pages.flatMap((page) => page.jobs);
  const byId = new Map<string, string[]>();
  for (const [id, definition] of Object.entries(workflow?.jobs ?? {}))
    byId.set(
      id,
      jobs
        .filter(
          (j) =>
            j.name === (definition.name ?? id) ||
            j.name.startsWith((definition.name ?? id) + " (") ||
            j.name.startsWith((definition.name ?? id) + " /"),
        )
        .map((j) => j.name),
    );
  const needs: Record<string, string[]> = {};
  for (const [id, definition] of Object.entries(workflow?.jobs ?? {})) {
    const dependencies =
      typeof definition.needs === "string" ? [definition.needs] : (definition.needs ?? []);
    const names = dependencies.flatMap((dependency) => byId.get(dependency) ?? []);
    if (dependencies.some((dependency) => !byId.get(dependency)?.length)) continue;
    for (const name of byId.get(id) ?? []) needs[name] = names;
  }
  // A rerun retains its original creation date, but has a fresh attempt start.
  // Keep initial queue time for attempt 1; never count the operator's wait to retry.
  const readyAt = run.run_attempt > 1 ? run.run_started_at || run.created_at : run.created_at;
  return jobTiming(jobs, readyAt, needs);
}
