// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { releasePackageFiles } from "./update-release-package-versions.ts";
import { assertReleaseCi } from "./lib/release-ci.ts";
import {
  assertReleaseProfileAllowed,
  desktopBuildMatrix,
  fetchReleaseSummaries,
  mergesMacManifests,
  readCheckedInReleaseProfile,
  resolveReleaseProfile,
} from "./lib/release-profile.ts";
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();
const dryRun = process.env.DRY_RUN === "true";
const ref = process.env.GITHUB_REF_NAME ?? "";
const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version as string;
// The checkout is the tagged commit, so tagged releases read the profile they were cut with.
const profile = resolveReleaseProfile({
  checkedIn: readCheckedInReleaseProfile("."),
  dryRun,
  override: process.env.PROFILE_OVERRIDE,
});
const releases = fetchReleaseSummaries(process.env.GITHUB_REPOSITORY!);
// Dry runs check the lock too, so a profile the tag would reject fails before tagging.
assertReleaseProfileAllowed(profile, releases);
assertReleaseCi({
  repository: process.env.GITHUB_REPOSITORY!,
  git: (args) => run("git", args),
  api: (path) => JSON.parse(run("gh", ["api", path])),
});
let version: string;
if (dryRun) {
  if (ref !== "main") throw new Error("Dry runs require main");
  version = `${current.split("-")[0]}-dryrun.${process.env.GITHUB_RUN_NUMBER}`;
} else {
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(ref)) throw new Error("Invalid release tag");
  version = versionToken(ref.slice(1));
  for (const file of releasePackageFiles)
    if (JSON.parse(readFileSync(file, "utf8")).version !== version)
      throw new Error(`Version mismatch: ${file}`);
  for (const release of releases)
    if (
      !release.draft &&
      /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.tag_name) &&
      compareCliReleaseVersions(version, release.tag_name.slice(1)) <= 0
    )
      throw new Error(`Version must exceed ${release.tag_name}`);
  if (!version.includes("-") && !readFileSync("CHANGELOG.md", "utf8").includes(`## [${version}]`))
    throw new Error("Stable release needs changelog entry");
}
const beta = version.includes("-beta.");
appendFileSync(
  process.env.GITHUB_OUTPUT!,
  [
    `version=${version}`,
    `tag=v${version}`,
    `channel=${beta ? "beta" : "latest"}`,
    `is_prerelease=${beta}`,
    `dry_run=${dryRun}`,
    `profile=${profile}`,
    `desktop_matrix=${JSON.stringify(desktopBuildMatrix(profile))}`,
    `merge_mac=${mergesMacManifests(profile)}`,
  ].join("\n") + "\n",
);
