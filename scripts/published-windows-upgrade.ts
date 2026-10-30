// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { parseDesktopUpdateManifest } from "./desktop-update-manifest.ts";
import type { PublishedReleaseSummary, ReleaseChannel } from "./lib/release-profile.ts";

/** Select by semver rather than API order; drafts never count as installed clients. */
export function publishedWindowsBaseline(
  releases: readonly PublishedReleaseSummary[],
  target: string,
  channel: ReleaseChannel,
): string | undefined {
  versionToken(target);
  const pattern = channel === "beta" ? /^v\d+\.\d+\.\d+-beta\.\d+$/ : /^v\d+\.\d+\.\d+$/;
  const release = releases
    .filter((entry) => !entry.draft && pattern.test(entry.tag_name))
    .toSorted((a, b) => compareCliReleaseVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
  if (!release) return undefined;
  const baseline = release.tag_name.slice(1);
  if (compareCliReleaseVersions(target, baseline) <= 0)
    throw new Error(`Upgrade target ${target} must exceed published ${baseline}`);
  for (const name of windowsUpgradeAssets(baseline, channel))
    if (!release.assets?.some((asset) => asset.name === name))
      throw new Error(`Published ${release.tag_name} is missing ${name}`);
  return baseline;
}

export function windowsUpgradeAssets(
  version: string,
  channel: ReleaseChannel,
): [string, string, string] {
  versionToken(version);
  return [`F5-${version}-x64.exe`, `F5-${version}-x64.exe.blockmap`, `${channel}.yml`];
}

/** Check the manifest before executing either the downloaded or candidate installer. */
export function verifyWindowsUpgradeArtifacts(
  dir: string,
  version: string,
  channel: ReleaseChannel,
): void {
  const [installer, blockmap, manifestName] = windowsUpgradeAssets(version, channel);
  const manifest = parseDesktopUpdateManifest(
    readFileSync(join(dir, manifestName), "utf8"),
    manifestName,
  );
  const file = manifest.files[0];
  if (manifest.version !== version || manifest.files.length !== 1 || file?.url !== installer)
    throw new Error(`Unexpected Windows update manifest for ${version}`);
  const bytes = readFileSync(join(dir, installer));
  if (
    file.size !== bytes.length ||
    file.sha512 !== createHash("sha512").update(bytes).digest("base64")
  )
    throw new Error(`Installer checksum/size mismatch: ${installer}`);
  if (readFileSync(join(dir, blockmap)).length === 0)
    throw new Error(`Empty installer blockmap: ${blockmap}`);
}
