// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { loadCandidate, runArtifacts } from "./release/candidate-store.ts";
import { pendingStableRequests, type ReleaseCandidate } from "./release/release-candidate.ts";
import { automationMode, selectPublication } from "./release/release-publication.ts";
import {
  assembleCandidate,
  publishCandidate,
  verifyPublicRelease,
  verifyCandidateCertification,
  verifyPublishedCandidate,
} from "./release/publish-candidate.ts";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import { sameBaselines, upgradePlan } from "./release/release-upgrade-proof.ts";
import { publicationGate } from "./release/release-publication-gate.ts";

const mode = automationMode(process.env.RELEASE_AUTOMATION_MODE);
const reconciliationStarted = Date.now();
const main = git(["rev-parse", "origin/main"]);
const history = git(["rev-list", "--first-parent", main]).split("\n").toReversed();
const releases = fetchReleaseSummaries(repository);
const published = new Map(
  releases
    .filter((r) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => [r.tag_name.slice(1), git(["rev-list", "-n", "1", r.tag_name])]),
);
const pending = pendingStableRequests(stableRequests(main), published);
const publicCommits = releases
  .filter((r) => !r.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name))
  .map((r) => git(["rev-list", "-n", "1", r.tag_name]));
const boundary = Math.max(-1, ...publicCommits.map((sha) => history.indexOf(sha)));
const since = boundary < 0 ? undefined : git(["show", "-s", "--format=%cI", history[boundary]!]);
const buildRuns = runs("release.yml", since).filter((r) => trustedRun(r, "release.yml"));
const latest = new Map<string, WorkflowRun>();
for (const run of buildRuns) if (!latest.has(run.head_sha)) latest.set(run.head_sha, run);
const ciRuns = runs("ci.yml", since).filter((r) => trustedRun(r, "ci.yml"));
const latestCi = new Map<string, WorkflowRun>();
for (const run of ciRuns) if (!latestCi.has(run.head_sha)) latestCi.set(run.head_sha, run);
const green: { sourceSha: string; order: number }[] = [];
for (const [sha, run] of latestCi) {
  const order = history.indexOf(sha);
  if (order < boundary || order < 0 || run.conclusion !== "success" || run.status !== "completed")
    continue;
  try {
    requireCi(sha, releaseProfileAt(sha));
    green.push({ sourceSha: sha, order });
  } catch (error) {
    console.log("Waiting for exact-SHA CI:", sha, String(error));
  }
}
const selected = selectPublication(green, pending);
if (!selected) {
  console.log("No publishable candidate; stable requests remain barriers until qualified.");
  process.exit(0);
}
const build = latest.get(selected.sourceSha);
if (!build || build.status !== "completed" || build.conclusion !== "success") {
  console.log(
    "Newest passing source awaits its candidate; older unpublished betas are superseded.",
  );
  process.exit(0);
}
const terminal = releases.find(
  (r) =>
    !r.draft &&
    r.assets?.some((a) => a.name === "f5-release-candidate.json") &&
    git(["rev-list", "-n", "1", r.tag_name]) === selected.sourceSha,
);
if (terminal) {
  const candidate = await verifyPublishedCandidate(terminal.tag_name, selected.sourceSha, build.id);
  writeFileSync(
    "release-summary.json",
    JSON.stringify(
      {
        mode,
        status: "already-published",
        sourceSha: candidate.sourceSha,
        version: candidate.version,
        candidateRun: candidate.runId,
        attempt: candidate.runAttempt,
        artifactDownloads: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Matching immutable release is already published and verified:", terminal.tag_name);
  process.exit(0);
}
const candidate = await loadCandidate(build.id);
if (mode === "beta" && candidate.kind === "stable") {
  console.log("Stable publication awaits all mode; later betas remain held.");
  process.exit(0);
}
const fresh = upgradePlan(candidate, releases);
const cacheKey = fresh.key + "-" + git(["rev-parse", "HEAD"]).slice(0, 12);
if (mode === "shadow") {
  const prior = api<{
    artifacts: ({
      workflow_run?: { id: number };
    } & import("./release/release-github.ts").RemoteArtifact)[];
  }>("actions/artifacts?name=shadow-verified-" + cacheKey + "&per_page=100").artifacts;
  for (const artifact of prior.filter((a) => !a.expired && a.workflow_run)) {
    const run = api<WorkflowRun>("actions/runs/" + artifact.workflow_run!.id);
    if (
      run.path === ".github/workflows/release-publish.yml" &&
      run.head_branch === "main" &&
      run.repository.full_name === repository &&
      run.head_repository.full_name === repository &&
      run.status === "completed" &&
      run.conclusion === "success"
    ) {
      const result = await readArtifactJson<{
        sourceSha: string;
        candidateRun: number;
        attempt: number;
      }>(artifact, "release-summary.json");
      if (
        result.sourceSha === candidate.sourceSha &&
        result.candidateRun === candidate.runId &&
        result.attempt === candidate.runAttempt
      ) {
        console.log("Shadow verification already succeeded; artifacts reused:", cacheKey);
        process.exit(0);
      }
    }
  }
}
if (!sameBaselines(candidate.windowsBaselines, fresh.baselines) || fresh.cliTargets.length) {
  const proofRuns = api<{ workflow_runs: (WorkflowRun & { display_title: string })[] }>(
    "actions/workflows/release-upgrade.yml/runs?event=workflow_dispatch&per_page=100",
  ).workflow_runs;
  const proof = proofRuns.find(
    (r) =>
      r.display_title === "Upgrade " + fresh.key &&
      r.repository.full_name === repository &&
      r.head_repository.full_name === repository &&
      r.path === ".github/workflows/release-upgrade.yml" &&
      r.head_branch === "main",
  );
  if (!proof) {
    gh([
      "workflow",
      "run",
      "release-upgrade.yml",
      "--ref",
      "main",
      "-f",
      "candidate_run=" + candidate.runId,
      "-f",
      "key=" + fresh.key,
    ]);
    console.log("Dispatched upgrade-only qualification", fresh.key);
    process.exit(0);
  }
  if (proof.status !== "completed" || proof.conclusion !== "success") {
    console.log("Upgrade qualification pending or blocked; rerun its failed jobs:", proof.id);
    process.exit(0);
  }
  const artifact = runArtifacts(proof.id).find(
    (a) => a.name === "upgrade-proof-" + fresh.key + "-attempt-" + proof.run_attempt,
  );
  if (!artifact) throw new Error("Upgrade proof is missing/expired");
  const evidence = await readArtifactJson<{ key: string; candidate: ReleaseCandidate }>(
    artifact,
    "proof.json",
  );
  if (
    evidence.key !== fresh.key ||
    JSON.stringify(evidence.candidate) !== JSON.stringify(candidate)
  )
    throw new Error("Upgrade proof does not match candidate");
}
const root = mkdtempSync(join(tmpdir(), "f5-release-publication-"));
const directory = join(root, "assets");
await assembleCandidate(candidate, directory);
if (mode === "shadow") await verifyCandidateCertification(candidate, directory);
// No candidate executables run here; only trusted tooling parses and hashes the archives.
if (mode !== "shadow") {
  // Refresh durable intent immediately before publication. A newly merged stable request is a barrier.
  git(["fetch", "origin", "main", "--tags"]);
  const currentPending = pendingStableRequests(
    stableRequests(git(["rev-parse", "origin/main"])),
    published,
  );
  if (currentPending.length && currentPending[0]!.sourceSha !== candidate.sourceSha)
    throw new Error("A stable request now holds publication");
  const now = upgradePlan(candidate, fetchReleaseSummaries(repository));
  if (now.key !== fresh.key)
    throw new Error("Upgrade baselines changed again; reconciliation will qualify them");
  await publishCandidate(candidate, directory, () => publicationGate(candidate, fresh.key));
  await verifyPublicRelease(candidate);
}
const summary = {
  mode,
  sourceSha: candidate.sourceSha,
  version: candidate.version,
  candidateRun: candidate.runId,
  attempt: candidate.runAttempt,
  ciRun: latestCi.get(candidate.sourceSha)!.id,
  ciAttempt: latestCi.get(candidate.sourceSha)!.run_attempt,
  buildRetries: candidate.runAttempt - 1,
  retainedComponents: candidate.artifacts.filter((a) => a.receipt.runAttempt < candidate.runAttempt)
    .length,
  queueSeconds: {
    candidate: Math.max(
      0,
      Math.round((Date.parse(build.run_started_at) - Date.parse(build.created_at)) / 1000),
    ),
    ci: Math.max(
      0,
      Math.round(
        (Date.parse(latestCi.get(candidate.sourceSha)!.run_started_at) -
          Date.parse(latestCi.get(candidate.sourceSha)!.created_at)) /
          1000,
      ),
    ),
    publication: Math.max(
      0,
      Math.round(
        (reconciliationStarted -
          Math.max(
            Date.parse(build.updated_at),
            Date.parse(latestCi.get(candidate.sourceSha)!.updated_at),
          )) /
          1000,
      ),
    ),
  },
  reason: selected.reason,
  reusedArtifacts: candidate.artifacts.length,
  retriedComponents: candidate.artifacts.filter((a) => a.receipt.runAttempt > 1).length,
  mergeToPublicSeconds:
    mode === "shadow"
      ? null
      : Math.round(
          (Date.parse(
            api<{ published_at: string }>("releases/tags/v" + candidate.version).published_at,
          ) -
            Date.parse(
              api<{ commit: { committer: { date: string } } }>("commits/" + candidate.sourceSha)
                .commit.committer.date,
            )) /
            1000,
        ),
  candidateSeconds: Math.round(
    (Date.parse(latest.get(candidate.sourceSha)!.updated_at) -
      Date.parse(latest.get(candidate.sourceSha)!.created_at)) /
      1000,
  ),
};
writeFileSync("release-summary.json", JSON.stringify(summary, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    "Release result\n\n" + JSON.stringify(summary, null, 2) + "\n",
  );
if (mode === "shadow" && process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, "cache_key=" + cacheKey + "\n");
