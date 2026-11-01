// @effect-diagnostics nodeBuiltinImport:off
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  gh,
  git,
  pages,
  repository,
  runs,
  stableRequests,
  trustedRun,
  type WorkflowRun,
} from "./release/release-github.ts";
import { qualifiedSource } from "./release/release-selection.ts";
import { observeRelease, releaseFields } from "./release/release-observability.ts";

function records(workflow: string): WorkflowRun[] {
  return (
    JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/" + repository + "/actions/workflows/" + workflow + "/runs?branch=main&per_page=100",
      ]),
    ) as { workflow_runs: WorkflowRun[] }[]
  ).flatMap((page) => page.workflow_runs);
}
function eligibleSnapshot(): { older: Set<string>; protectedRuns: Set<number> } {
  git(["fetch", "origin", "main", "--tags"]);
  const main = git(["rev-parse", "origin/main"]);
  // Invalid durable intent blocks cancellation as well as publication.
  stableRequests(main);
  const history = git(["rev-list", "--first-parent", main]).split("\n").toReversed();
  const selected = qualifiedSource(history, runs("ci.yml"));
  if (!selected) return { older: new Set(), protectedRuns: new Set() };
  const older = new Set(history.slice(0, history.indexOf(selected.sourceSha)));
  // A publisher may be creating its draft now; conservatively wait for it.
  if (
    records("release-publish.yml").some(
      (r) =>
        r.repository.full_name === repository &&
        r.head_repository.full_name === repository &&
        r.path === ".github/workflows/release-publish.yml" &&
        r.head_branch === "main" &&
        r.status === "in_progress",
    )
  )
    return { older: new Set(), protectedRuns: new Set() };
  for (const release of pages<{ draft: boolean; tag_name: string }>("releases?per_page=100"))
    if (release.draft) {
      // Missing/invalid draft tags must fail closed rather than guess the source.
      const sha = git(["rev-list", "-n", "1", release.tag_name]);
      older.delete(sha);
    }
  const protectedRuns = new Set<number>();
  for (const run of records("release-upgrade.yml")) {
    if (
      run.repository.full_name !== repository ||
      run.head_repository.full_name !== repository ||
      run.path !== ".github/workflows/release-upgrade.yml" ||
      run.head_branch !== "main" ||
      run.status === "completed"
    )
      continue;
    const title = (run as WorkflowRun & { display_title?: string }).display_title ?? "";
    const match = /^Upgrade ([1-9]\d*)-/.exec(title);
    if (!match) return { older: new Set(), protectedRuns };
    protectedRuns.add(Number(match[1]));
  }
  return { older, protectedRuns };
}
export async function coordinateReleases(): Promise<void> {
  await observeRelease(async () => {
    releaseFields({ status: "coordinating", cancelledRuns: [] });
    const cancelled: number[] = [];
    for (const run of runs("release.yml").filter(
      (r) => trustedRun(r, "release.yml") && r.status !== "completed",
    )) {
      // Recompute durable ordering and protected references immediately before each mutation.
      const snapshot = eligibleSnapshot();
      if (!snapshot.older.has(run.head_sha) || snapshot.protectedRuns.has(run.id)) continue;
      // At its original SHA, a stable request cannot be hidden by a later withdrawal/recovery.
      if (stableRequests(run.head_sha).some((intent) => intent.sourceSha === run.head_sha))
        continue;
      const current = api<WorkflowRun>("actions/runs/" + run.id);
      if (
        !trustedRun(current, "release.yml") ||
        current.head_sha !== run.head_sha ||
        current.run_attempt !== run.run_attempt ||
        current.status === "completed"
      )
        continue;
      try {
        gh([
          "api",
          "--method",
          "POST",
          "repos/" + repository + "/actions/runs/" + run.id + "/cancel",
        ]);
      } catch (error) {
        // Completion racing cancellation is success, other failures remain visible.
        if (api<WorkflowRun>("actions/runs/" + run.id).status !== "completed") throw error;
        continue;
      }
      cancelled.push(run.id);
      releaseFields({
        cancelledRuns: [...cancelled],
        status: "superseded-beta",
        reason: "newer exact-source CI passed",
      });
    }
    if (!cancelled.length) releaseFields({ status: "no-obsolete-beta" });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await coordinateReleases();
