// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import { parseDesktopUpdateManifest } from "./desktop-update-manifest.ts";
import type { PublishedReleaseSummary, ReleaseChannel } from "./lib/release-profile.ts";

export interface PublishedWindowsUpgrade {
  readonly baseline: string;
  readonly baselineChannel: ReleaseChannel;
  readonly clientChannel: ReleaseChannel;
}

/** Cover stable clients and the stable-or-beta feed followed by beta clients. */
export function publishedWindowsBaselines(
  releases: readonly PublishedReleaseSummary[],
  target: string,
  channel: ReleaseChannel,
): PublishedWindowsUpgrade[] {
  versionToken(target);
  const published = releases
    .filter((entry) => !entry.draft && /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(entry.tag_name))
    .toSorted((a, b) => compareCliReleaseVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
  const latest = published[0];
  if (!latest) return [];
  if (compareCliReleaseVersions(target, latest.tag_name.slice(1)) <= 0)
    throw new Error(
      `Upgrade target ${target} must exceed published ${latest.tag_name}. Run node scripts/prepare-release.ts <next-version> before rehearsing an upgrade.`,
    );
  const plans: PublishedWindowsUpgrade[] = [];
  const add = (release: PublishedReleaseSummary, clientChannel: ReleaseChannel) => {
    const baseline = release.tag_name.slice(1);
    const baselineChannel = baseline.includes("-beta.") ? "beta" : "latest";
    for (const name of windowsUpgradeAssets(baseline, baselineChannel))
      if (!release.assets?.some((asset) => asset.name === name))
        throw new Error(`Published ${release.tag_name} is missing ${name}`);
    plans.push({ baseline, baselineChannel, clientChannel });
  };
  if (channel === "latest") {
    const stable = published.find((entry) => !entry.tag_name.includes("-"));
    if (stable) add(stable, "latest");
  }
  add(latest, "beta");
  return plans;
}

/** Keep the first-release job running so its successful skip does not skip assembly. */
export function publishedWindowsUpgradeMatrix(
  releases: readonly PublishedReleaseSummary[],
  target: string,
  channel: ReleaseChannel,
): { include: PublishedWindowsUpgrade[] } {
  const plans = publishedWindowsBaselines(releases, target, channel);
  return {
    include: plans.length
      ? plans
      : [{ baseline: "", baselineChannel: channel, clientChannel: channel }],
  };
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
