// @effect-diagnostics nodeBuiltinImport:off
import { git, repository, stableRequests } from "./release/release-github.ts";
import { pendingStableRequests } from "./release/release-candidate.ts";
import { fetchReleaseSummaries } from "./lib/release-profile.ts";
import { readFileSync } from "node:fs";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import { releasePackageFiles } from "./update-release-package-versions.ts";

const releases = fetchReleaseSummaries(repository).filter((release) => !release.draft);
const published = new Map(
  releases
    .filter((release) => !release.draft && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => [release.tag_name.slice(1), git(["rev-list", "-n", "1", release.tag_name])]),
);
const pending = pendingStableRequests(stableRequests(git(["rev-parse", "HEAD"])), published);
const version =
  pending.at(-1)?.version ??
  [...published.keys()].toSorted((a, b) => compareCliReleaseVersions(b, a))[0];
if (!version) throw new Error("Release intent validation requires a published stable base");
for (const file of releasePackageFiles)
  if (JSON.parse(readFileSync(file, "utf8")).version !== version)
    throw new Error("Release package version disagrees with durable intent: " + file);
if (pending.length)
  for (const release of releases.filter((entry) =>
    /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(entry.tag_name),
  ))
    if (compareCliReleaseVersions(version, release.tag_name.slice(1)) <= 0)
      throw new Error("Pending stable version is already published or superseded");
console.log("Release intent merge-result validation passed; pending requests:", pending.length);
