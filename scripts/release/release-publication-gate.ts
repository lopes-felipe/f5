import type { ReleaseCandidate } from "./release-candidate.ts";
import { pendingStableRequests } from "./release-candidate.ts";
import { git, repository, requireCi, runs, stableRequests, trustedRun } from "./release-github.ts";
import { fetchReleaseSummaries } from "../lib/release-profile.ts";
import { upgradePlan } from "./release-upgrade-proof.ts";

/** Re-evaluate after downloads/uploads: a completed newer CI or recovery intent wins. */
export function publicationGate(candidate: ReleaseCandidate, qualifiedUpgradeKey: string): void {
  git(["fetch", "origin", "main", "--tags"]);
  const main = git(["rev-parse", "origin/main"]);
  const releases = fetchReleaseSummaries(repository);
  const published = new Map(
    releases
      .filter((r) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
      .map((r) => [r.tag_name.slice(1), git(["rev-list", "-n", "1", r.tag_name])]),
  );
  const pending = pendingStableRequests(stableRequests(main), published);
  if (pending.length && pending[0]!.sourceSha !== candidate.sourceSha)
    throw new Error("Stable request or explicit recovery now holds publication");
  if (candidate.kind === "stable" && !pending.some((r) => r.sourceSha === candidate.sourceSha))
    throw new Error("Stable candidate is no longer the pinned request");
  if (upgradePlan(candidate, releases).key !== qualifiedUpgradeKey)
    throw new Error(
      "Published upgrade baselines changed; reconciliation will requalify existing artifacts",
    );
  if (candidate.kind === "beta") {
    const history = git(["rev-list", "--first-parent", main]).split("\n");
    const index = history.indexOf(candidate.sourceSha);
    if (index < 0) throw new Error("Candidate is not on main's first-parent history");
    const newer = new Set(history.slice(0, index));
    const latest = new Map<string, ReturnType<typeof runs>[number]>();
    for (const run of runs("ci.yml", git(["show", "-s", "--format=%cI", candidate.sourceSha])))
      if (trustedRun(run, "ci.yml") && !latest.has(run.head_sha)) latest.set(run.head_sha, run);
    for (const [sha, run] of latest) {
      if (!newer.has(sha) || run.status !== "completed" || run.conclusion !== "success") continue;
      let qualified = false;
      try {
        requireCi(sha, candidate.profile);
        qualified = true;
      } catch {
        continue;
      }
      if (qualified)
        throw new Error("Newer passing main commit supersedes this unpublished beta: " + sha);
    }
  }
}
