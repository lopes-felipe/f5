// @effect-diagnostics nodeBuiltinImport:off
// Dependency-free: the publish job runs this without installing workspace packages.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_PROFILES = ["windows", "all"] as const;
export type ReleaseProfile = (typeof RELEASE_PROFILES)[number];
export type DesktopPlatform = "mac" | "win" | "linux";
export type ReleaseChannel = "latest" | "beta";

export interface DesktopBuild {
  readonly os: string;
  readonly platform: DesktopPlatform;
  readonly arch: string;
  readonly target: string;
}

export interface DesktopUpdateFeed {
  readonly manifest: string;
  readonly installers: readonly string[];
}

export interface DesktopReleaseAssets {
  readonly feeds: readonly DesktopUpdateFeed[];
  readonly installers: readonly string[];
  readonly requiredBlockmaps: readonly string[];
  readonly optionalBlockmaps: readonly string[];
}

const DESKTOP_BUILDS: Record<DesktopPlatform, readonly DesktopBuild[]> = {
  mac: [
    // macOS 26 rejects electron-builder 26.15.3's keychain setup, which passes the
    // certificate password to `set-key-partition-list`; 26.18.0 fixes it.
    { os: "macos-15", platform: "mac", arch: "arm64", target: "dmg" },
    { os: "macos-15-intel", platform: "mac", arch: "x64", target: "dmg" },
  ],
  win: [{ os: "windows-latest", platform: "win", arch: "x64", target: "nsis" }],
  linux: [{ os: "ubuntu-latest", platform: "linux", arch: "x64", target: "AppImage" }],
};

const PROFILE_PLATFORMS: Record<ReleaseProfile, readonly DesktopPlatform[]> = {
  windows: ["win"],
  all: ["mac", "win", "linux"],
};

const PLATFORM_FEEDS: Record<
  DesktopPlatform,
  (version: string, channel: ReleaseChannel) => DesktopUpdateFeed & { blockmaps: string[] }
> = {
  mac: (version, channel) => ({
    manifest: `${channel}-mac.yml`,
    installers: ["arm64.dmg", "arm64.zip", "x64.dmg", "x64.zip"].map(
      (suffix) => `F5-${version}-${suffix}`,
    ),
    blockmaps: [],
  }),
  win: (version, channel) => ({
    manifest: `${channel}.yml`,
    installers: [`F5-${version}-x64.exe`],
    // Differential NSIS downloads need the blockmap; electron-builder always emits it.
    blockmaps: [`F5-${version}-x64.exe.blockmap`],
  }),
  linux: (version, channel) => ({
    manifest: `${channel}-linux.yml`,
    installers: [`F5-${version}-x86_64.AppImage`],
    blockmaps: [],
  }),
};

/** Updater manifests by platform, regardless of version, on either channel. */
const PLATFORM_MANIFEST_PATTERNS: Record<DesktopPlatform, RegExp> = {
  mac: /^(latest|beta)-mac\.yml$/,
  win: /^(latest|beta)\.yml$/,
  linux: /^(latest|beta)-linux\.yml$/,
};

export function parseReleaseProfile(value: unknown): ReleaseProfile {
  if (typeof value === "string" && (RELEASE_PROFILES as readonly string[]).includes(value))
    return value as ReleaseProfile;
  throw new Error(`Invalid release profile: ${String(value)}`);
}

export function readCheckedInReleaseProfile(root: string): ReleaseProfile {
  const value: unknown = JSON.parse(readFileSync(join(root, "release-profile.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("desktop" in value))
    throw new Error("release-profile.json must contain a desktop profile");
  return parseReleaseProfile(value.desktop);
}

/** Tagged releases always use the checked-in profile; only dry runs may override it. */
export function resolveReleaseProfile(input: {
  readonly checkedIn: ReleaseProfile;
  readonly dryRun: boolean;
  readonly override?: string | undefined;
}): ReleaseProfile {
  if (!input.dryRun || !input.override || input.override === "checked-in") return input.checkedIn;
  return parseReleaseProfile(input.override);
}

export function releaseProfilePlatforms(profile: ReleaseProfile): readonly DesktopPlatform[] {
  return PROFILE_PLATFORMS[profile];
}

export function desktopBuildMatrix(profile: ReleaseProfile): { include: DesktopBuild[] } {
  return { include: PROFILE_PLATFORMS[profile].flatMap((platform) => DESKTOP_BUILDS[platform]) };
}

export function mergesMacManifests(profile: ReleaseProfile): boolean {
  return PROFILE_PLATFORMS[profile].includes("mac");
}

export function desktopReleaseAssets(
  profile: ReleaseProfile,
  version: string,
  channel: ReleaseChannel,
): DesktopReleaseAssets {
  const feeds = PROFILE_PLATFORMS[profile].map((platform) =>
    PLATFORM_FEEDS[platform](version, channel),
  );
  const installers = feeds.flatMap((feed) => feed.installers);
  const requiredBlockmaps = feeds.flatMap((feed) => feed.blockmaps);
  return {
    feeds: feeds.map(({ manifest, installers }) => ({ manifest, installers })),
    installers,
    requiredBlockmaps,
    optionalBlockmaps: installers
      .map((name) => `${name}.blockmap`)
      .filter((name) => !requiredBlockmaps.includes(name)),
  };
}

export interface PublishedReleaseSummary {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly assets?: readonly { readonly name: string }[];
}

/** Lists every release, including drafts and their asset names, through the GitHub CLI. */
export function fetchReleaseSummaries(repository: string): PublishedReleaseSummary[] {
  const pages = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as PublishedReleaseSummary[][];
  return pages.flat();
}

/**
 * Once any published release ships updater manifests for a platform, every later
 * release must keep serving it: stable updaters read `/releases/latest`, so a
 * release omitting that platform's manifest would break its updates.
 */
export function assertReleaseProfileAllowed(
  profile: ReleaseProfile,
  releases: readonly PublishedReleaseSummary[],
): void {
  const included = PROFILE_PLATFORMS[profile];
  for (const release of releases) {
    if (release.draft) continue;
    for (const asset of release.assets ?? []) {
      for (const [platform, pattern] of Object.entries(PLATFORM_MANIFEST_PATTERNS) as [
        DesktopPlatform,
        RegExp,
      ][]) {
        if (!included.includes(platform) && pattern.test(asset.name))
          throw new Error(
            `Release profile "${profile}" omits ${platform}, but ${release.tag_name} published ${asset.name}. Use the "all" profile.`,
          );
      }
    }
  }
}
