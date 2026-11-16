import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { compareReportMetadata, type PerformanceReport } from "./lib/performance/report.ts";

interface BaselineRun {
  readonly id: number;
  readonly workflow_id: number;
  readonly head_branch: string;
  readonly head_repository: { readonly id: number } | null;
  readonly event: string;
  readonly conclusion: string;
}
interface BaselineArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly created_at: string;
  readonly workflow_run: { readonly id: number; readonly head_repository_id: number } | null;
}
/** Only successful main runs of this repository's nightly workflow are trusted. */
export function selectNightlyBaselineArtifact(input: {
  readonly workflowId: number;
  readonly repositoryId: number;
  readonly runs: ReadonlyArray<BaselineRun>;
  readonly artifacts: ReadonlyArray<BaselineArtifact>;
}): number | undefined {
  const trustedRuns = new Set(
    input.runs
      .filter(
        (run) =>
          run.workflow_id === input.workflowId &&
          run.head_repository?.id === input.repositoryId &&
          run.head_branch === "main" &&
          run.conclusion === "success" &&
          (run.event === "schedule" || run.event === "workflow_dispatch"),
      )
      .map((run) => run.id),
  );
  return input.artifacts
    .filter(
      (artifact) =>
        artifact.name === "perf-baseline" &&
        !artifact.expired &&
        artifact.workflow_run?.head_repository_id === input.repositoryId &&
        trustedRuns.has(artifact.workflow_run.id),
    )
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id;
}

export function nightlyBaselineDecision(
  candidate: PerformanceReport,
  baseline?: PerformanceReport,
  reset = false,
) {
  if (
    candidate.scope !== "server-component" ||
    candidate.mode !== "measurement" ||
    candidate.method.warmups !== 5 ||
    candidate.method.repetitions !== 30
  )
    throw new Error(
      "Nightly baselines require full server measurements (5 warmups, 30 repetitions).",
    );
  if (reset) return { replace: true, reason: "Baseline reset requested." };
  if (!baseline)
    return { replace: true, reason: "No baseline available; recorded candidate as baseline." };
  const incompatibilities = compareReportMetadata(baseline, candidate);
  if (incompatibilities.length)
    return {
      replace: true,
      reason: `Baseline incompatible, re-baselined: ${incompatibilities.join(", ")}`,
    };
  return { replace: false, reason: "Compared candidate with compatible baseline." };
}
if (import.meta.main) {
  if (process.argv[2] === "baseline-artifact") {
    const repository = process.env.GH_REPO;
    const repositoryId = Number(process.env.REPOSITORY_ID);
    if (!repository || !Number.isSafeInteger(repositoryId) || repositoryId <= 0)
      throw new Error("GH_REPO and REPOSITORY_ID are required.");
    const api = <A>(path: string): A => {
      const result = spawnSync("gh", ["api", `repos/${repository}/${path}`], { encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Baseline discovery failed: ${result.stderr}`);
      return JSON.parse(result.stdout) as A;
    };
    const workflow = api<{ id: number }>("actions/workflows/perf-nightly.yml");
    const { workflow_runs: runs } = api<{ workflow_runs: BaselineRun[] }>(
      `actions/workflows/${workflow.id}/runs?branch=main&status=success&per_page=100`,
    );
    const { artifacts } = api<{ artifacts: BaselineArtifact[] }>(
      "actions/artifacts?name=perf-baseline&per_page=100",
    );
    const id = selectNightlyBaselineArtifact({
      workflowId: workflow.id,
      repositoryId,
      runs,
      artifacts,
    });
    if (id !== undefined) console.log(id);
  } else {
    const candidatePath = process.argv[2] ?? ".performance/candidate.json";
    const baselinePath = process.argv[3] ?? ".performance/baseline/candidate.json";
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as PerformanceReport;
    const candidate = read(candidatePath);
    const baseline = existsSync(baselinePath) ? read(baselinePath) : undefined;
    const decision = nightlyBaselineDecision(
      candidate,
      baseline,
      process.env.RESET_BASELINE === "true",
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `replace-baseline=${decision.replace}\n`);
    let summary =
      "Nightly comparisons do not gate merges. A regression fails this workflow.\n\n" +
      decision.reason +
      "\n";
    console.log(decision.reason);
    if (decision.replace && process.env.RESET_BASELINE !== "true") {
      const warning = baseline
        ? "Baseline incompatible: no performance comparison was made. The previous baseline is retained in the candidate diagnostics artifact; qualification requires a compatible comparison."
        : "No retained baseline: initializing without a performance comparison. This may follow artifact expiry after failed comparisons; qualification requires a compatible comparison.";
      console.log(`::warning::${warning}`);
      summary += `\n> **Warning:** ${warning}\n`;
    }
    if (!decision.replace) {
      const comparison = spawnSync("bun", ["run", "perf:compare", baselinePath, candidatePath], {
        encoding: "utf8",
      });
      const output = `${comparison.stdout ?? ""}${comparison.stderr ?? ""}`;
      console.log(output);
      summary += `\n\`\`\`text\n${output}\n\`\`\`\n`;
      if (comparison.error) throw comparison.error;
      process.exitCode = comparison.status ?? 1;
    }
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (!process.exitCode) {
      // Refresh artifact retention without moving a compatible comparison anchor.
      // Regressions never promote the candidate or refresh a failed baseline run.
      const retainedPath = process.argv[4] ?? ".performance/retained-baseline/candidate.json";
      mkdirSync(dirname(retainedPath), { recursive: true });
      writeFileSync(retainedPath, JSON.stringify(decision.replace ? candidate : baseline));
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, "retain-baseline=true\n");
    }
  }
}
