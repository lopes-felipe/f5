// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  api,
  gh,
  git,
  readArtifactJson,
  repository,
  publisherIdentity,
  runs,
  stableRequests,
  trustedRun,
  type WorkflowRun,
} from "./release/release-github.ts";
import { loadCandidate, runArtifacts } from "./release/candidate-store.ts";
import { pendingStableRequests, type ReleaseCandidate } from "./release/release-candidate.ts";
import { automationMode } from "./release/release-publication.ts";
import { latestRuns, qualifiedSource, stableCiAction } from "./release/release-selection.ts";
import { observeRelease, releaseFields, releasePhase } from "./release/release-observability.ts";
import { workflowTiming } from "./release/release-timing.ts";
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
import { parsePublicationLease, type PublicationLease } from "./release/release-lease.ts";

const MAX_CANDIDATE_ATTEMPTS = 3;
const MAX_CI_ATTEMPTS = 3;

/** A stable source's failed CI is retried like its build, then fails the publisher visibly. */
function recoverStableCi(sha: string, mode: ReturnType<typeof automationMode>): void {
  const records = api<{ workflow_runs: WorkflowRun[] }>(
    "actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=" + sha + "&per_page=100",
  ).workflow_runs;
  const decision = stableCiAction(records, sha, mode, MAX_CI_ATTEMPTS);
  if (decision.action === "wait") return;
  const { run } = decision;
  const url = "https://github.com/" + repository + "/actions/runs/" + run.id;
  if (decision.action === "rerun") {
    try {
      gh([
        "api",
        "-X",
        "POST",
        "repos/" + repository + "/actions/runs/" + run.id + "/rerun-failed-jobs",
      ]);
      const reason =
        "Re-running failed stable CI jobs (attempt " +
        (run.run_attempt + 1) +
        " of " +
        MAX_CI_ATTEMPTS +
        ")";
      releaseFields({
        status: "retrying-ci",
        reason,
        ciRun: run.id,
        ciAttempt: run.run_attempt + 1,
      });
      console.log(reason, url);
      return;
    } catch (error) {
      releaseFields({ status: "blocked-stable-ci" });
      throw new Error(
        "Stable CI is blocked (" +
          run.conclusion +
          "): " +
          url +
          "; automatic rerun failed: " +
          String(error),
      );
    }
  }
  releaseFields({ status: "blocked-stable-ci", ciRun: run.id, ciAttempt: run.run_attempt });
  throw new Error(
    "Stable CI is blocked (" +
      run.conclusion +
      ", attempt " +
      run.run_attempt +
      "): " +
      url +
      ". Rerun failed jobs with: gh run rerun " +
      run.id +
      " --failed",
  );
}

interface ReconcileOptions {
  leaseOnly?: boolean;
  lease?: PublicationLease;
}
export async function reconcileReleases(options: ReconcileOptions = {}): Promise<void> {
  await observeRelease(async () => {
    const lease = await reconcile(options);
    if (!options.leaseOnly) return;
    // Publish a marker for every successful selection, including waiting/terminal
    // outcomes. Missing markers still mean the publisher has not selected safely.
    writeFileSync(
      "release-publication-lease.json",
      JSON.stringify(lease ?? { candidateRun: null }, null, 2) + "\n",
    );
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        "selection_ready=true\nlease_key=" +
          (lease ? lease.candidateRun + "-" + lease.attempt : "none") +
          "\n" +
          (lease
            ? "candidate_run=" + lease.candidateRun + "\nattempt=" + lease.attempt + "\n"
            : ""),
      );
  });
}
async function reconcile(options: ReconcileOptions): Promise<PublicationLease | undefined> {
  const mode = automationMode(process.env.RELEASE_AUTOMATION_MODE);
  releaseFields({
    mode,
    status: "waiting-ci",
    reason: "No main source has passed every required CI job",
    publicationRun: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    publicationAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    publicationEvent: process.env.GITHUB_EVENT_NAME ?? null,
  });
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
  releaseFields({
    requestId: pending[0]?.requestId ?? null,
    sourceSha: pending[0]?.sourceSha ?? main,
    version: pending[0]?.version ?? null,
    status: pending.length ? "blocked-stable-ci" : "waiting-ci",
  });
  const publicCommits = releases
    .filter((r) => !r.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name))
    .map((r) => git(["rev-list", "-n", "1", r.tag_name]));
  const boundary = Math.max(-1, ...publicCommits.map((sha) => history.indexOf(sha)));
  const since = boundary < 0 ? undefined : git(["show", "-s", "--format=%cI", history[boundary]!]);
  const buildRuns = runs("release.yml", since).filter((r) => trustedRun(r, "release.yml"));
  const latest = latestRuns(buildRuns);
  const ciRuns = pending.length ? [] : runs("ci.yml", since).filter((r) => trustedRun(r, "ci.yml"));
  const latestCi = latestRuns(ciRuns);
  const selected = qualifiedSource(history, ciRuns, pending, boundary);
  if (!selected) {
    if (pending.length) recoverStableCi(pending[0]!.sourceSha, mode);
    console.log("No publishable candidate; stable requests remain barriers until qualified.");
    return;
  }
  latestCi.set(selected.sourceSha, selected.ci);
  const build = latest.get(selected.sourceSha);
  releaseFields({
    sourceSha: selected.sourceSha,
    ciRun: selected.ci.id,
    ciAttempt: selected.ci.run_attempt,
    candidateRun: build?.id ?? null,
    attempt: build?.run_attempt ?? null,
    reason: selected.reason,
    supersededSources: history.filter(
      (sha) =>
        history.indexOf(sha) < history.indexOf(selected.sourceSha) &&
        !publicCommits.includes(sha) &&
        latest.has(sha),
    ),
    workflowUrls: {
      ci: "https://github.com/" + repository + "/actions/runs/" + selected.ci.id,
      candidate: build ? "https://github.com/" + repository + "/actions/runs/" + build.id : null,
    },
  });
  const terminal = releases.find(
    (r) =>
      !r.draft &&
      r.assets?.some((a) => a.name === "f5-release-candidate.json") &&
      git(["rev-list", "-n", "1", r.tag_name]) === selected.sourceSha,
  );
  if (terminal && build) {
    const candidate = await verifyPublishedCandidate(
      terminal.tag_name,
      selected.sourceSha,
      build.id,
    );
    releaseFields({
      mode,
      status: "already-published",
      sourceSha: candidate.sourceSha,
      version: candidate.version,
      candidateRun: candidate.runId,
      attempt: candidate.runAttempt,
      artifactDownloads: 0,
    });
    console.log("Matching immutable release is already published and verified:", terminal.tag_name);
    return;
  }
  if (build?.status === "completed" && build.conclusion !== "success") {
    let rerunFailure = "";
    if (
      (build.conclusion === "failure" || build.conclusion === "timed_out") &&
      mode !== "shadow" &&
      build.run_attempt < MAX_CANDIDATE_ATTEMPTS
    ) {
      try {
        gh([
          "api",
          "-X",
          "POST",
          "repos/" + repository + "/actions/runs/" + build.id + "/rerun-failed-jobs",
        ]);
        const reason =
          "Re-running failed candidate jobs (attempt " +
          (build.run_attempt + 1) +
          " of " +
          MAX_CANDIDATE_ATTEMPTS +
          ")";
        releaseFields({
          status: "retrying-build",
          reason,
          candidateRun: build.id,
          attempt: build.run_attempt + 1,
        });
        console.log(reason, "https://github.com/" + repository + "/actions/runs/" + build.id);
        return;
      } catch (error) {
        rerunFailure = "; automatic rerun failed: " + String(error);
      }
    }
    releaseFields({ status: "blocked-build" });
    throw new Error(
      "Candidate build is blocked (" +
        build.conclusion +
        "): https://github.com/" +
        repository +
        "/actions/runs/" +
        build.id +
        ". Rerun failed jobs with: gh run rerun " +
        build.id +
        " --failed" +
        rerunFailure,
    );
  }
  if (!build || build.status !== "completed" || build.conclusion !== "success") {
    releaseFields({
      status: "waiting-build",
      reason: "Newest qualified source awaits its candidate build",
    });
    console.log(
      "Newest passing source awaits its candidate; older unpublished betas are superseded.",
    );
    return;
  }
  const candidate = await loadCandidate(build.id);
  releaseFields({
    version: candidate.version,
    requestId: candidate.stableIntent?.requestId ?? null,
    componentArtifacts: candidate.artifacts.map((a) => ({
      component: a.component,
      id: a.id,
      attempt: a.receipt.runAttempt,
      signingRetries: a.receipt.signingRetries ?? 0,
    })),
  });
  if (mode === "beta" && candidate.kind === "stable") {
    releaseFields({
      status: "blocked-stable-mode",
      reason: "Stable publication requires all mode; later betas remain held",
    });
    console.log("Stable publication awaits all mode; later betas remain held.");
    return;
  }
  const identity = {
    sourceSha: candidate.sourceSha,
    candidateRun: candidate.runId,
    attempt: candidate.runAttempt,
  };
  if (
    options.lease &&
    JSON.stringify(identity) !== JSON.stringify(parsePublicationLease(options.lease))
  ) {
    releaseFields({
      status: candidate.kind === "beta" ? "superseded-beta" : "blocked-stable-lease",
      reason: "Selection changed after publication lease; reconcile again",
    });
    return;
  }
  if (options.leaseOnly) {
    releaseFields({ status: "candidate-ready" });
    return identity;
  }
  const fresh = upgradePlan(candidate, releases);
  const cacheKey = fresh.key + "-" + publisherIdentity();
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
          releaseFields({
            status: "shadow-verified",
            reusedVerification: run.id,
            artifactDownloads: 0,
          });
          return;
        }
      }
    }
  }
  let requalification: { runId: number; attempt: number } | null = null;
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
      releaseFields({
        status: "waiting-upgrade",
        upgradeKey: fresh.key,
        reason: "Changed upgrade baselines require qualification of retained artifacts",
      });
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
      return;
    }
    releaseFields({
      upgradeRun: proof.id,
      upgradeAttempt: proof.run_attempt,
      upgradeKey: fresh.key,
    });
    if (proof.status === "completed" && proof.conclusion !== "success") {
      releaseFields({ status: "blocked-upgrade" });
      throw new Error("Upgrade qualification is blocked; rerun its failed jobs: " + proof.id);
    }
    if (proof.status !== "completed") {
      releaseFields({
        status: "waiting-upgrade",
        reason: "Matching upgrade qualification is still running",
      });
      console.log("Upgrade qualification pending or blocked; rerun its failed jobs:", proof.id);
      return;
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
    requalification = { runId: proof.id, attempt: proof.run_attempt };
  }
  const root = mkdtempSync(join(tmpdir(), "f5-release-publication-"));
  const directory = join(root, "assets");
  releaseFields({ status: "verifying-candidate" });
  await releasePhase("assembly", () =>
    assembleCandidate(candidate, directory, {
      key: fresh.key,
      windowsBaselines: fresh.baselines,
      cliBaseline: fresh.cliBaseline,
      requalification,
    }),
  );
  if (mode === "shadow") await verifyCandidateCertification(candidate);
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
    releaseFields({ status: "publishing" });
    await releasePhase("publication", () =>
      publishCandidate(candidate, directory, () => publicationGate(candidate, fresh.key)),
    );
    await releasePhase("publicChecks", () => verifyPublicRelease(candidate));
  }
  const timingErrors: string[] = [];
  const timing = <T>(name: string, read: () => T): T | null => {
    try {
      return read();
    } catch (error) {
      timingErrors.push(name + ": " + String(error));
      console.warn("Release timing unavailable:", name, String(error));
      return null;
    }
  };
  const jobTimings = {
    candidate: timing("candidate", () => workflowTiming(build)),
    ci: timing("ci", () => workflowTiming(selected.ci)),
    publisher: process.env.GITHUB_RUN_ID
      ? timing("publisher", () =>
          workflowTiming(api<WorkflowRun>("actions/runs/" + process.env.GITHUB_RUN_ID)),
        )
      : null,
  };
  const maxQueue = (jobs: ReturnType<typeof workflowTiming> | null) => {
    const known =
      jobs?.flatMap((job) => (job.queueSeconds === null ? [] : [job.queueSeconds])) ?? [];
    return known.length ? Math.max(...known) : null;
  };
  const summary = {
    status: mode === "shadow" ? "shadow-verified" : "published",
    mode,
    sourceSha: candidate.sourceSha,
    version: candidate.version,
    candidateRun: candidate.runId,
    attempt: candidate.runAttempt,
    ciRun: latestCi.get(candidate.sourceSha)!.id,
    ciAttempt: latestCi.get(candidate.sourceSha)!.run_attempt,
    buildRetries: candidate.runAttempt - 1,
    retainedComponents: candidate.artifacts.filter(
      (a) => a.receipt.runAttempt < candidate.runAttempt,
    ).length,
    queueSeconds: {
      // Maximum individual job queue; per-job details avoid summing parallel work.
      candidate: maxQueue(jobTimings.candidate),
      ci: maxQueue(jobTimings.ci),
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
        : timing("merge-to-public", () =>
            Math.round(
              (Date.parse(
                api<{ published_at: string }>("releases/tags/v" + candidate.version).published_at,
              ) -
                Date.parse(
                  api<{ commit: { committer: { date: string } } }>("commits/" + candidate.sourceSha)
                    .commit.committer.date,
                )) /
                1000,
            ),
          ),
    candidateSeconds: Math.round(
      (Date.parse(latest.get(candidate.sourceSha)!.updated_at) -
        Date.parse(latest.get(candidate.sourceSha)!.created_at)) /
        1000,
    ),
  };
  releaseFields({ ...summary, jobTimings, timingErrors });
  if (mode === "shadow" && process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, "cache_key=" + cacheKey + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { "lease-only": { type: "boolean" }, lease: { type: "string" } },
  });
  await reconcileReleases({
    leaseOnly: values["lease-only"] ?? false,
    ...(values.lease
      ? { lease: parsePublicationLease(JSON.parse(readFileSync(values.lease, "utf8"))) }
      : {}),
  });
}
