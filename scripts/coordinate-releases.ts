// @effect-diagnostics nodeBuiltinImport:off
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  gh,
  git,
  readArtifactJson,
  repository,
  requireCi,
  releaseProfileAt,
  runs,
  stableRequests,
  trustedRun,
  type WorkflowRun,
} from "./release/release-github.ts";
import { qualifiedSource } from "./release/release-selection.ts";
import { observeRelease, releaseFields } from "./release/release-observability.ts";
import { parsePublicationSelection, type PublicationSelection } from "./release/release-lease.ts";
import { runArtifacts } from "./release/candidate-store.ts";
import { automationMode } from "./release/release-publication.ts";

const activeStatuses = ["in_progress", "queued", "waiting", "pending", "requested"];
function activeRecords(workflow: string, statuses = activeStatuses): WorkflowRun[] {
  const records = statuses.flatMap((status) => {
    const response = JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/" +
          repository +
          "/actions/workflows/" +
          workflow +
          "/runs?branch=main&per_page=100&status=" +
          status,
      ]),
    ) as { total_count: number; workflow_runs: WorkflowRun[] }[];
    // Filtered Actions searches cap results at 1,000; incomplete protection is unsafe.
    if (response.some((page) => page.total_count >= 1000))
      throw new Error("Too many active workflow runs to coordinate safely");
    return response.flatMap((page) => page.workflow_runs);
  });
  return [...new Map(records.map((run) => [run.id, run])).values()];
}
async function protectedSnapshot(
  cache: Map<string, PublicationSelection>,
): Promise<{ sources: Set<string>; runs: Set<number>; selecting: boolean }> {
  const sources = new Set<string>(),
    protectedRuns = new Set<number>();
  // Read-only tokens may not see draft releases. Every automation draft reserves
  // its immutable tag first, so protect all version-tagged sources independently.
  for (const tag of git(["for-each-ref", "--format=%(refname:short)", "refs/tags/v*"]).split("\n"))
    if (/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag)) sources.add(git(["rev-list", "-n", "1", tag]));
  for (const run of activeRecords("release-publish.yml", ["in_progress"]).filter(
    (r) =>
      r.repository.full_name === repository &&
      r.head_repository.full_name === repository &&
      r.path === ".github/workflows/release-publish.yml" &&
      r.head_branch === "main" &&
      r.status === "in_progress",
  )) {
    const key = run.id + "-" + run.run_attempt;
    let lease = cache.get(key);
    if (!lease) {
      const leases = runArtifacts(run.id).filter(
        (artifact) =>
          artifact.name.startsWith("release-lease-") &&
          artifact.name.endsWith("-publisher-" + run.run_attempt),
      );
      // Old publishers and the short pre-lease interval fail closed.
      if (leases.length !== 1 || leases[0]!.expired)
        return { sources, runs: protectedRuns, selecting: true };
      lease = parsePublicationSelection(
        await readArtifactJson(leases[0]!, "release-publication-lease.json"),
      );
      if (
        leases[0]!.name !==
        "release-lease-" +
          (lease.candidateRun === null ? "none" : lease.candidateRun + "-" + lease.attempt) +
          "-publisher-" +
          run.run_attempt
      )
        throw new Error("Publication lease artifact identity mismatch");
      cache.set(key, lease);
    }
    // Normally selected builds are complete. Keep this defensive protection for
    // a rerun of the same candidate while an earlier verified attempt publishes.
    if (lease.candidateRun !== null) protectedRuns.add(lease.candidateRun);
  }
  // Drafts reserve their version tag before creation; no release-history scan is needed.
  for (const run of activeRecords("release-upgrade.yml")) {
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
    if (!match) return { sources, runs: protectedRuns, selecting: true };
    protectedRuns.add(Number(match[1]));
  }
  return { sources, runs: protectedRuns, selecting: false };
}
export async function coordinateReleases(): Promise<void> {
  await observeRelease(async () => {
    releaseFields({ status: "coordinating", cancelledRuns: [] });
    const mode = automationMode(process.env.RELEASE_AUTOMATION_MODE);
    releaseFields({ mode });
    if (mode === "shadow") {
      releaseFields({
        status: "coordination-disabled",
        reason: "Publication automation is disabled",
      });
      return;
    }
    const builds = activeRecords("release.yml").filter(
      (r) => trustedRun(r, "release.yml") && r.status !== "completed",
    );
    if (!builds.length) {
      releaseFields({ status: "no-obsolete-beta" });
      return;
    }
    git(["fetch", "origin", "main", "--tags"]);
    const main = git(["rev-parse", "origin/main"]);
    // Cache immutable history/intent once. A changed main tip aborts this invocation.
    stableRequests(main);
    const history = git(["rev-list", "--first-parent", main]).split("\n").toReversed();
    // Main CI and candidate push runs start together. Include a day of clock skew;
    // old reruns retain their original creation date. Unknown dates fail closed.
    const created = builds.map((run) => Date.parse(run.created_at));
    if (!created.every(Number.isFinite)) throw new Error("Candidate creation time is unavailable");
    const since = new Date(Math.min(...created) - 86400000).toISOString();
    const selected = qualifiedSource(history, runs("ci.yml", since));
    if (!selected) {
      releaseFields({ status: "waiting-ci", reason: "No newer source has passed required CI" });
      return;
    }
    const older = new Set(history.slice(0, history.indexOf(selected.sourceSha)));
    const leases = new Map<string, PublicationSelection>();
    const cancelled: number[] = [];
    const stableSources = new Map<string, boolean>();
    let deferred: string | undefined;
    for (const run of builds) {
      if (!older.has(run.head_sha)) continue;
      // At its original SHA, a stable request cannot be hidden by a later withdrawal/recovery.
      if (!stableSources.has(run.head_sha))
        stableSources.set(
          run.head_sha,
          stableRequests(run.head_sha).some((intent) => intent.sourceSha === run.head_sha),
        );
      if (stableSources.get(run.head_sha)) continue;
      // Refresh only mutable eligibility: main/tags, exact-source CI, active
      // publisher/proof references and the target run. Never rescan all history.
      git(["fetch", "origin", "main", "--tags"]);
      if (git(["rev-parse", "origin/main"]) !== main) {
        deferred = "Main changed; refresh selection on the next reconciliation";
        break;
      }
      try {
        const ci = requireCi(selected.sourceSha, releaseProfileAt(selected.sourceSha));
        if (ci.id !== selected.ci.id || ci.run_attempt !== selected.ci.run_attempt) {
          deferred = "Qualified CI identity changed";
          break;
        }
      } catch {
        deferred = "Required CI no longer passes";
        break;
      }
      const protection = await protectedSnapshot(leases);
      if (protection.selecting) {
        deferred = "Publisher selection or upgrade identity is not yet available";
        break;
      }
      if (protection.sources.has(run.head_sha) || protection.runs.has(run.id)) continue;
      const current = api<WorkflowRun>("actions/runs/" + run.id);
      if (
        !trustedRun(current, "release.yml") ||
        current.id !== run.id ||
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
    if (deferred) releaseFields({ status: "coordination-deferred", reason: deferred });
    else if (!cancelled.length) releaseFields({ status: "no-obsolete-beta" });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await coordinateReleases();
