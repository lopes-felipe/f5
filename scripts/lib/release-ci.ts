export interface ReleaseCiDependencies {
  repository: string;
  git: (args: string[]) => string;
  api: (path: string) => unknown;
}

interface Run {
  id: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
}

function readRun(value: unknown): Run {
  const run = value as Partial<Run> | null;
  if (
    !run ||
    !Number.isSafeInteger(run.id) ||
    run.id! < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt! < 1 ||
    typeof run.head_sha !== "string" ||
    typeof run.event !== "string" ||
    typeof run.status !== "string" ||
    !(run.conclusion === null || typeof run.conclusion === "string") ||
    typeof run.created_at !== "string" ||
    !Number.isFinite(Date.parse(run.created_at))
  )
    throw new Error("Malformed CI run response");
  return run as Run;
}

/** No waiting or fallback: release eligibility belongs to this SHA's latest push attempt. */
export function assertReleaseCi({ repository, git, api }: ReleaseCiDependencies): void {
  const sha = git(["rev-parse", "HEAD"]);
  git(["merge-base", "--is-ancestor", sha, "origin/main"]);
  const base = `repos/${repository}/actions`;
  const response = api(
    `${base}/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=100`,
  ) as { workflow_runs?: unknown[] } | null;
  if (!response || !Array.isArray(response.workflow_runs))
    throw new Error("Malformed CI workflow response");
  const selected = response.workflow_runs
    .map(readRun)
    .filter((run) => run.head_sha === sha && run.event === "push")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
  if (!selected) throw new Error("No CI push run for the exact release SHA");

  const assertSuccessful = (value: unknown) => {
    const run = readRun(value);
    if (
      run.id !== selected.id ||
      run.head_sha !== sha ||
      run.event !== "push" ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    )
      throw new Error(
        "Latest CI push attempt must be completed and successful for the release SHA",
      );
    return run;
  };
  const latest = assertSuccessful(api(`${base}/runs/${selected.id}`));
  const attemptPath = `${base}/runs/${latest.id}/attempts/${latest.run_attempt}`;
  const attempt = assertSuccessful(api(attemptPath));
  if (attempt.run_attempt !== latest.run_attempt) throw new Error("CI attempt changed");
  const gates: { name: string; status: string; conclusion: string | null }[] = [];
  let received = 0;
  for (let page = 1; ; page++) {
    const result = api(`${attemptPath}/jobs?per_page=100&page=${page}`) as {
      total_count?: number;
      jobs?: { name: string; status: string; conclusion: string | null }[];
    } | null;
    if (
      !result ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count! < 0 ||
      !Array.isArray(result.jobs) ||
      received + result.jobs.length > result.total_count! ||
      (!result.jobs.length && received < result.total_count!)
    )
      throw new Error("Malformed or incomplete CI jobs response");
    for (const job of result.jobs) {
      if (!job || typeof job.name !== "string") throw new Error("Malformed CI job");
      if (job.name === "CI result") gates.push(job);
    }
    received += result.jobs.length;
    if (received >= result.total_count!) break;
  }
  if (gates.length !== 1 || gates[0]!.status !== "completed" || gates[0]!.conclusion !== "success")
    throw new Error("Release SHA requires one successful CI result gate");
  // A rerun may start while jobs are being read. Never certify the older attempt.
  if (assertSuccessful(api(`${base}/runs/${latest.id}`)).run_attempt !== latest.run_attempt)
    throw new Error("A newer CI attempt started during release preflight");
}
