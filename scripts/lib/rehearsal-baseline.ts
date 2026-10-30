// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import type { PublishedReleaseSummary } from "./release-profile.ts";

export type RehearsalChannel = "latest" | "beta";

export interface PublishedRehearsalBaseline {
  readonly tag: string;
  readonly version: string;
  /** The channel the published installer was packaged for. */
  readonly channel: RehearsalChannel;
  /** The installer, its blockmap and its manifest. */
  readonly assets: readonly string[];
}

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

/**
 * The newest published Windows installer a client on `channel` could be running. Beta
 * releases start from the newest beta. Stable releases start from the newest stable,
 * or, before any stable exists, from the newest beta: beta clients take stable
 * releases from the Atom feed, falling back from `beta.yml` to `latest.yml`.
 */
export function selectPublishedBaseline(
  releases: readonly PublishedReleaseSummary[],
  channel: RehearsalChannel,
): PublishedRehearsalBaseline | undefined {
  const candidates = releases
    .flatMap((release): PublishedRehearsalBaseline[] => {
      const version = release.tag_name.replace(/^v/, "");
      if (release.draft || !RELEASE_VERSION.test(version)) return [];
      const releaseChannel: RehearsalChannel = version.includes("-") ? "beta" : "latest";
      const assets = [
        `F5-${version}-x64.exe`,
        `F5-${version}-x64.exe.blockmap`,
        `${releaseChannel}.yml`,
      ];
      const names = new Set((release.assets ?? []).map((asset) => asset.name));
      if (![...assets, "SHA256SUMS"].every((name) => names.has(name))) return [];
      return [{ tag: release.tag_name, version, channel: releaseChannel, assets }];
    })
    .sort((left, right) => compareCliReleaseVersions(right.version, left.version));
  const newest = (wanted: RehearsalChannel) => candidates.find((entry) => entry.channel === wanted);
  return channel === "beta" ? newest("beta") : (newest("latest") ?? newest("beta"));
}

/**
 * A target version above `baseline` that its client resolves on `channel`: the release
 * version itself, or, for check and dry-run builds, the next version on the channel.
 */
export function rehearsalTarget(
  version: string,
  channel: RehearsalChannel,
  baseline: string,
): string {
  const after = (candidate: string) => compareCliReleaseVersions(candidate, baseline) > 0;
  const onChannel = RELEASE_VERSION.exec(version)?.[4] !== undefined;
  if (RELEASE_VERSION.test(version) && onChannel === (channel === "beta") && after(version))
    return version;
  const core = /^(\d+\.\d+\.\d+)/.exec(version)?.[1];
  if (!core) throw new Error(`Invalid release version: ${version}`);
  const first = channel === "beta" ? `${core}-beta.1` : core;
  if (after(first)) return first;
  const [, major, minor, patch, beta] = RELEASE_VERSION.exec(baseline) ?? [];
  if (major === undefined) throw new Error(`Invalid baseline version: ${baseline}`);
  if (channel === "beta" && beta !== undefined)
    return `${major}.${minor}.${patch}-beta.${Number(beta) + 1}`;
  const next = `${major}.${minor}.${Number(patch) + 1}`;
  return channel === "beta" ? `${next}-beta.1` : next;
}

/** Checks each named file in `dir` against its line in the release's `SHA256SUMS`. */
export function verifyDownloadedChecksums(
  dir: string,
  checksums: string,
  names: readonly string[],
): void {
  const expected = new Map(
    checksums
      .split("\n")
      .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line))
      .flatMap((match) => (match ? [[match[2]!, match[1]!] as const] : [])),
  );
  for (const name of names) {
    const hash = expected.get(name);
    if (!hash) throw new Error(`SHA256SUMS has no entry for ${name}`);
    const actual = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    if (actual !== hash) throw new Error(`Published ${name} does not match SHA256SUMS`);
  }
}
