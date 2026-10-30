// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import { pendingStableRequests } from "./release/release-candidate.ts";
import { parseReleaseIntent } from "./release/release-intent.ts";
import { gh, git, repository, stableRequests } from "./release/release-github.ts";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import { prepareChangelog } from "./prepare-release.ts";
import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";
const intent = parseReleaseIntent(
  process.env.WITHDRAWS
    ? {
        action: "withdraw",
        requestId: process.env.REQUEST_ID,
        withdraws: process.env.WITHDRAWS.split(",").map((id) => id.trim()),
        reason: process.env.WITHDRAW_REASON,
      }
    : {
        version: process.env.VERSION,
        requestId: process.env.REQUEST_ID,
        ...(process.env.SUPERSEDES ? { supersedes: process.env.SUPERSEDES } : {}),
      },
);
const branch = "release/prepare-" + intent.requestId;
const title =
  "action" in intent ? "Withdraw release request " + intent.requestId : "Release " + intent.version;
const existing = JSON.parse(
  gh(["pr", "list", "--repo", repository, "--head", branch, "--state", "all", "--json", "url"]),
) as { url: string }[];
if (existing.length) {
  console.log(existing[0]!.url);
  process.exit(0);
}
function openPreparationPr(): void {
  const body =
    "action" in intent
      ? "Explicitly withdraw intent history entries: " +
        intent.withdraws.join(", ") +
        ".\n\nReason: " +
        intent.reason +
        "\n\nMerging releases their publication barrier. Existing public releases and immutable tags are untouched."
      : "Prepare stable F5 " +
        intent.version +
        ".\n\nMerging this PR authorizes automatic publication of its exact main merge commit after full CI, signed packaging, upgrade and certification checks. No beta is produced for that commit.\n\nRequest: " +
        intent.requestId +
        (intent.supersedes
          ? "\n\nExplicit recovery of unpublished request: " + intent.supersedes
          : "");
  const file = process.env.RUNNER_TEMP + "/release-pr.md";
  writeFileSync(file, body);
  console.log(
    gh([
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      file,
    ]),
  );
}
// Resume a successful push whose PR creation was interrupted, preserving its commit.
const remote = git(["ls-remote", "--heads", "origin", "refs/heads/" + branch]);
if (remote) {
  const sha = remote.split(/\s+/)[0]!;
  git(["fetch", "origin", sha]);
  const found = parseReleaseIntent(JSON.parse(git(["show", sha + ":release-intent.json"])));
  if (JSON.stringify(found) !== JSON.stringify(intent))
    throw new Error("Existing preparation branch has a different request");
  openPreparationPr();
  process.exit(0);
}
const releases = fetchReleaseSummaries(repository).filter((r) => !r.draft);
for (const release of releases.filter((r) => /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name)))
  if (!("action" in intent))
    if (compareCliReleaseVersions(intent.version, release.tag_name.slice(1)) <= 0)
      throw new Error("Stable version is already published or superseded");
const published = new Map(
  releases
    .filter((r) => /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => [r.tag_name.slice(1), git(["rev-list", "-n", "1", r.tag_name])]),
);
const history = stableRequests(git(["rev-parse", "HEAD"]), intent);
const pending = pendingStableRequests(history, published);
if (!("action" in intent) && git(["ls-remote", "--tags", "origin", "refs/tags/v" + intent.version]))
  throw new Error(
    "This version has a reserved immutable tag; resume it, or withdraw the request and prepare a higher unused version",
  );
git(["switch", "-c", branch]);
const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
if ("action" in intent) {
  const base =
    pending.at(-1)?.version ??
    [...published.keys()].toSorted((a, b) => compareCliReleaseVersions(b, a))[0];
  if (!base) throw new Error("Withdrawal requires a published stable base");
  updateReleasePackageVersions(base);
  if (base !== current && !published.has(current)) {
    const heading = "## [" + current + "]";
    const changelog = readFileSync("CHANGELOG.md", "utf8")
      .split("\n")
      .filter((line) => !line.startsWith(heading + " - "))
      .join("\n");
    writeFileSync("CHANGELOG.md", changelog);
  }
  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { stdio: "inherit" });
} else if (intent.supersedes) {
  if (current !== intent.version)
    throw new Error("Recovery must retain the same unpublished version");
} else {
  if (compareCliReleaseVersions(intent.version, current) <= 0)
    throw new Error("Stable version must increase");
  updateReleasePackageVersions(intent.version);
  writeFileSync(
    "CHANGELOG.md",
    prepareChangelog(
      readFileSync("CHANGELOG.md", "utf8"),
      intent.version,
      new Date().toISOString().slice(0, 10),
    ),
  );
  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], { stdio: "inherit" });
}
writeFileSync("release-intent.json", JSON.stringify(intent, null, 2) + "\n");
execFileSync("bun", ["fmt"], { stdio: "inherit" });
git(["config", "user.name", "F5 Release Automation"]);
git(["config", "user.email", "release-automation@users.noreply.github.com"]);
git(["add", ...releasePackageFiles, "bun.lock", "CHANGELOG.md", "release-intent.json"]);
git(["commit", "-m", title + " (" + intent.requestId + ")"]);
git(["push", "origin", "HEAD:refs/heads/" + branch]);
openPreparationPr();
