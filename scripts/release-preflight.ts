import { parse } from "yaml";
import {
  selectReleaseCiRun,
  requiredReleaseCiJobs,
  assertReleaseCiJobs,
  dryRunReleaseVersion,
  type CiRun,
  type CiJob,
  type CiWorkflow,
} from "./lib/release-qualification.ts";
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { releasePackageFiles } from "./update-release-package-versions.ts";
import { publishedWindowsUpgradeMatrix } from "./published-windows-upgrade.ts";
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
let version: string;
if (dryRun) {
  if (ref !== "main") throw new Error("Dry runs require main");
  version = dryRunReleaseVersion(current, process.env.GITHUB_RUN_NUMBER ?? "");
} else {
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(ref)) throw new Error("Invalid release tag");
  version = versionToken(ref.slice(1));
  for (const file of releasePackageFiles)
    if (JSON.parse(readFileSync(file, "utf8")).version !== version)
      throw new Error(`Version mismatch: ${file}`);
  const sha = run("git", ["rev-parse", "HEAD"]);
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const runs = JSON.parse(
    run("gh", [
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
    ]),
  ) as { workflow_runs: CiRun[] };
  const qualifiedRun = selectReleaseCiRun(runs.workflow_runs, sha);
  const jobPages = JSON.parse(
    run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${qualifiedRun.id}/jobs?filter=all&per_page=100`,
    ]),
  ) as { jobs: CiJob[] }[];
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as CiWorkflow;
  assertReleaseCiJobs(
    jobPages.flatMap((page) => page.jobs),
    requiredReleaseCiJobs(workflow, profile),
  );
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
const windowsUpgradeMatrix = publishedWindowsUpgradeMatrix(
  releases,
  version,
  beta ? "beta" : "latest",
);
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
    `windows_upgrade_matrix=${JSON.stringify(windowsUpgradeMatrix)}`,
  ].join("\n") + "\n",
);
