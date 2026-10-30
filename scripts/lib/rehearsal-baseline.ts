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

export interface BaselineSelection {
  readonly baseline: PublishedRehearsalBaseline | undefined;
  /** Published releases that could not serve as a baseline, with the reason. */
  readonly skipped: readonly string[];
}

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;
const WINDOWS_RELEASE_ASSET = /\.exe$|^(latest|beta)\.yml$/;

/**
 * The newest published Windows installer a client on `channel` could be running.
 * Beta releases start from the newest release of either channel: a stable install
 * keeps a beta preference saved before it updated. Stable releases start from the
 * newest stable, or, before any stable exists, from the newest beta, whose clients
 * take stable releases from the Atom feed and fall back from `beta.yml` to `latest.yml`.
 *
 * Once a Windows release is published, falling back to the unpublished pair would
 * quietly weaken the rehearsal, so a published release that has a Windows asset but
 * can't serve as a baseline makes the selection fail.
 */
export function selectPublishedBaseline(
  releases: readonly PublishedReleaseSummary[],
  channel: RehearsalChannel,
): BaselineSelection {
  const skipped: string[] = [];
  const candidates: PublishedRehearsalBaseline[] = [];
  for (const release of releases) {
    if (release.draft) continue;
    const names = new Set((release.assets ?? []).map((asset) => asset.name));
    const windows = [...names].some((name) => WINDOWS_RELEASE_ASSET.test(name));
    const version = release.tag_name.replace(/^v/, "");
    if (!RELEASE_VERSION.test(version)) {
      if (windows) skipped.push(`${release.tag_name}: not a stable or beta.N version`);
      continue;
    }
    const releaseChannel: RehearsalChannel = version.includes("-") ? "beta" : "latest";
    const assets = [
      `F5-${version}-x64.exe`,
      `F5-${version}-x64.exe.blockmap`,
      `${releaseChannel}.yml`,
    ];
    const missing = [...assets, "SHA256SUMS"].filter((name) => !names.has(name));
    if (missing.length) {
      if (windows) skipped.push(`${release.tag_name}: missing ${missing.join(", ")}`);
      continue;
    }
    candidates.push({ tag: release.tag_name, version, channel: releaseChannel, assets });
  }
  candidates.sort((left, right) => compareCliReleaseVersions(right.version, left.version));
  const newest = (wanted?: RehearsalChannel) =>
    candidates.find((entry) => wanted === undefined || entry.channel === wanted);
  const baseline = channel === "beta" ? newest() : (newest("latest") ?? newest("beta"));
  if (!baseline && skipped.length)
    throw new Error(
      `Published Windows releases exist, but none can serve as the rehearsal baseline:\n  ${skipped.join("\n  ")}`,
    );
  return { baseline, skipped };
}

/**
 * The target version the baseline's client must update to on `channel`. A stable or
 * beta.N version is the release itself and must be above the baseline; check and
 * dry-run builds get the next version on the channel instead.
 */
export function rehearsalTarget(
  version: string,
  channel: RehearsalChannel,
  baseline: string,
): string {
  const after = (candidate: string) => compareCliReleaseVersions(candidate, baseline) > 0;
  const release = RELEASE_VERSION.exec(version);
  if (release) {
    if ((release[4] !== undefined) !== (channel === "beta"))
      throw new Error(`Release ${version} is not on the ${channel} channel`);
    if (!after(version))
      throw new Error(`Release ${version} is not above the baseline ${baseline}`);
    return version;
  }
  const core = /^(\d+\.\d+\.\d+)-(?:check|dryrun)\.\d+$/.exec(version)?.[1];
  if (!core) throw new Error(`Invalid rehearsal version: ${version}`);
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
      .split(/\r?\n/)
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
