import {
  acceptanceOnlyCommit,
  requireCi,
  releaseProfileAt,
  trustedRun,
  type WorkflowRun,
} from "./release-github.ts";
import { selectPublication } from "./release-publication.ts";
import type { StableRequest } from "./release-candidate.ts";

export function latestRuns(records: readonly WorkflowRun[]): Map<string, WorkflowRun> {
  const result = new Map<string, WorkflowRun>();
  for (const run of records.toSorted(
    (a, b) => b.run_number - a.run_number || b.id - a.id || b.run_attempt - a.run_attempt,
  ))
    if (!result.has(run.head_sha)) result.set(run.head_sha, run);
  return result;
}
/** Oldest-to-newest first-parent history; qualification is shared with the coordinator. */
export function qualifiedSource(
  history: readonly string[],
  records: readonly WorkflowRun[],
  pending: readonly StableRequest[] = [],
  boundary = -1,
): { sourceSha: string; reason: string; ci: WorkflowRun } | null {
  const latest = latestRuns(records.filter((run) => trustedRun(run, "ci.yml")));
  for (const sha of pending.length ? [pending[0]!.sourceSha] : history.toReversed()) {
    const run = latest.get(sha),
      order = history.indexOf(sha);
    if (
      order < Math.max(boundary, 0) ||
      (!pending.length &&
        (!run ||
          run.status !== "completed" ||
          run.conclusion !== "success" ||
          acceptanceOnlyCommit(sha)))
    )
      continue;
    try {
      const ci = requireCi(sha, releaseProfileAt(sha));
      const selection = selectPublication([{ sourceSha: sha, order }], pending);
      if (selection) return { ...selection, ci };
    } catch (error) {
      console.log("Waiting for exact-SHA CI:", sha, String(error));
    }
  }
  return null;
}
