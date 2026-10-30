// @effect-diagnostics nodeBuiltinImport:off
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import { candidateVersion, type ReleasePlan } from "./release/release-candidate.ts";
import { git, stableRequests } from "./release/release-github.ts";
import {
  assertReleaseProfileAllowed,
  desktopBuildMatrix,
  fetchReleaseSummaries,
  readCheckedInReleaseProfile,
} from "./lib/release-profile.ts";
import {
  publishedWindowsBaselines,
  publishedWindowsUpgradeMatrix,
} from "./published-windows-upgrade.ts";
import { releasePackageFiles } from "./update-release-package-versions.ts";

const sourceSha = git(["rev-parse", "HEAD"]);
const releases = fetchReleaseSummaries(process.env.GITHUB_REPOSITORY!);
const stable = releases
  .filter((r) => !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
  .toSorted((a, b) => compareCliReleaseVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
if (!stable) throw new Error("Automatic releases require an existing published stable base");
const requests = stableRequests(sourceSha);
const request = requests.at(-1) ?? null;
const stableSha = git(["rev-list", "-n", "1", stable.tag_name]);
const anchorSha = request?.sourceSha ?? stableSha;
git(["merge-base", "--is-ancestor", stableSha, sourceSha]);
const baseVersion = request?.version ?? stable.tag_name.slice(1);
for (const file of releasePackageFiles)
  if (JSON.parse(readFileSync(file, "utf8")).version !== baseVersion)
    throw new Error("Checked-in package versions must match the stable base: " + file);
const resolved = candidateVersion({
  sourceSha,
  anchorSha,
  baseVersion,
  distance: Number(git(["rev-list", "--first-parent", "--count", anchorSha + ".." + sourceSha])),
  request,
});
for (const release of releases.filter(
  (r) => !r.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name),
))
  if (compareCliReleaseVersions(resolved.version, release.tag_name.slice(1)) <= 0)
    throw new Error("Candidate is superseded by published " + release.tag_name);
const profile = readCheckedInReleaseProfile(".");
assertReleaseProfileAllowed(profile, releases);
const plan: ReleasePlan = {
  schemaVersion: 1,
  sourceSha,
  ...resolved,
  profile,
  anchorSha,
  stableIntent: request
    ? {
        version: request.version,
        requestId: request.requestId,
        ...(request.supersedes ? { supersedes: request.supersedes } : {}),
      }
    : null,
  runId: Number(process.env.GITHUB_RUN_ID),
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  createdAt: new Date().toISOString(),
  toolchain: {
    node: process.version,
    bun: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    bunWindowsArm64: readFileSync(
      ".github/actions/setup/windows-arm64/.bun-version",
      "utf8",
    ).trim(),
    lockSha256: createHash("sha256").update(readFileSync("bun.lock")).digest("hex"),
  },
  windowsBaselines: publishedWindowsBaselines(releases, resolved.version, resolved.channel),
};
writeFileSync("release-plan.json", JSON.stringify(plan, null, 2) + "\n");
const matrix = desktopBuildMatrix(profile).include;
appendFileSync(
  process.env.GITHUB_OUTPUT!,
  [
    "version=" + plan.version,
    "channel=" + plan.channel,
    "profile=" + profile,
    "mac_matrix=" + JSON.stringify({ include: matrix.filter((m) => m.platform === "mac") }),
    "windows_upgrade_matrix=" +
      JSON.stringify(publishedWindowsUpgradeMatrix(releases, plan.version, plan.channel)),
  ].join("\n") + "\n",
);
console.log(JSON.stringify(plan));
