import {
  api,
  gh,
  readArtifactJson,
  repository,
  trustedRun,
  type RemoteArtifact,
  type WorkflowRun,
} from "./release-github.ts";
import { validateCandidate, type ReleaseCandidate } from "./release-candidate.ts";

export function runArtifacts(id: number): RemoteArtifact[] {
  return (
    JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/" + repository + "/actions/runs/" + id + "/artifacts?per_page=100",
      ]),
    ) as { artifacts: RemoteArtifact[] }[]
  ).flatMap((p) => p.artifacts);
}
export async function loadCandidate(id: number): Promise<ReleaseCandidate> {
  const run = api<WorkflowRun>("actions/runs/" + id);
  if (!trustedRun(run, "release.yml") || run.status !== "completed" || run.conclusion !== "success")
    throw new Error("Candidate must come from a successful trusted main push build");
  const artifact = runArtifacts(id).find(
    (a) => a.name === "release-candidate-attempt-" + run.run_attempt,
  );
  if (!artifact) throw new Error("Candidate manifest is missing or expired");
  const candidate = await readArtifactJson<ReleaseCandidate>(artifact, "candidate.json");
  validateCandidate(candidate);
  if (
    candidate.runId !== run.id ||
    candidate.runAttempt !== run.run_attempt ||
    candidate.sourceSha !== run.head_sha
  )
    throw new Error("Candidate manifest does not match its source run");
  const jobs = api<{ jobs: { name: string; conclusion: string }[] }>(
    "actions/runs/" + id + "/jobs?per_page=100",
  ).jobs;
  if (!jobs.some((j) => j.name === "candidate" && j.conclusion === "success"))
    throw new Error("Candidate validation job did not pass");
  return candidate;
}
