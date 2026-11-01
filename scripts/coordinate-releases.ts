// @effect-diagnostics nodeBuiltinImport:off
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  gh,
  git,
  pages,
  readArtifactJson,
  repository,
  runs,
  stableRequests,
  trustedRun,
  type WorkflowRun,
} from "./release/release-github.ts";
import { qualifiedSource } from "./release/release-selection.ts";
import { observeRelease, releaseFields } from "./release/release-observability.ts";
import { parsePublicationLease } from "./release/release-lease.ts";
import { runArtifacts } from "./release/candidate-store.ts";

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
async function eligibleSnapshot(): Promise<{ older: Set<string>; protectedRuns: Set<number> }> {
  git(["fetch", "origin", "main", "--tags"]);
  const main = git(["rev-parse", "origin/main"]);
  // Invalid durable intent blocks cancellation as well as publication.
  stableRequests(main);
  const history = git(["rev-list", "--first-parent", main]).split("\n").toReversed();
  const selected = qualifiedSource(history, runs("ci.yml"));
  if (!selected) return { older: new Set(), protectedRuns: new Set() };
  const older = new Set(history.slice(0, history.indexOf(selected.sourceSha)));
  // Read-only tokens may not see draft releases. Every automation draft reserves
  // its immutable tag first, so protect all version-tagged sources independently.
  for (const tag of git(["for-each-ref", "--format=%(refname:short)", "refs/tags/v*"]).split("\n"))
    if (/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag))
      older.delete(git(["rev-list", "-n", "1", tag]));
  const protectedRuns = new Set<number>();
  for (const run of records("release-publish.yml").filter(
    (r) =>
      r.repository.full_name === repository &&
      r.head_repository.full_name === repository &&
      r.path === ".github/workflows/release-publish.yml" &&
      r.head_branch === "main" &&
      r.status === "in_progress",
  )) {
    const leases = runArtifacts(run.id).filter(
      (artifact) =>
        artifact.name.startsWith("release-lease-") &&
        artifact.name.endsWith("-publisher-" + run.run_attempt),
    );
    // Old publishers and the short pre-lease interval fail closed.
    if (leases.length !== 1 || leases[0]!.expired) return { older: new Set(), protectedRuns };
    const lease = parsePublicationLease(
      await readArtifactJson(leases[0]!, "release-publication-lease.json"),
    );
    if (
      leases[0]!.name !==
      "release-lease-" + lease.candidateRun + "-" + lease.attempt + "-publisher-" + run.run_attempt
    )
      throw new Error("Publication lease artifact identity mismatch");
    protectedRuns.add(lease.candidateRun);
  }
  for (const release of pages<{ draft: boolean; tag_name: string }>("releases?per_page=100"))
    if (release.draft) {
      // Missing/invalid draft tags must fail closed rather than guess the source.
      const sha = git(["rev-list", "-n", "1", release.tag_name]);
      older.delete(sha);
    }
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
      const snapshot = await eligibleSnapshot();
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
