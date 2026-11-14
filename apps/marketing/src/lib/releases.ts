import { DEFAULT_RELEASE_REPOSITORY } from "./releaseRepository";

declare const __F5_RELEASE_REPOSITORY__: string | undefined;

/** Validated in `astro.config.mjs` at build time. */
export const RELEASE_REPOSITORY =
  typeof __F5_RELEASE_REPOSITORY__ === "string"
    ? __F5_RELEASE_REPOSITORY__
    : DEFAULT_RELEASE_REPOSITORY;

export const REPOSITORY_URL = `https://github.com/${RELEASE_REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

const CACHE_KEY_PREFIX = "f5-latest-release:v1:";
export const RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

interface CachedRelease {
  fetchedAt: number;
  release: Release;
}

type ReleaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isGitHubUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Accepts only the fields the pages use. Assets with unexpected names or
 * non-GitHub download URLs are dropped rather than linked.
 */
export function parseRelease(value: unknown): Release | null {
  if (!isRecord(value)) return null;
  const { tag_name: tagName, html_url: htmlUrl, assets } = value;
  if (typeof tagName !== "string" || tagName.length === 0 || tagName.length > 128) return null;
  if (!isGitHubUrl(htmlUrl) || !Array.isArray(assets)) return null;
  const validAssets = assets.flatMap((asset): ReleaseAsset[] => {
    if (!isRecord(asset)) return [];
    const { name, browser_download_url: downloadUrl } = asset;
    if (typeof name !== "string" || !/^[\w.+-]{1,200}$/.test(name)) return [];
    if (!isGitHubUrl(downloadUrl)) return [];
    return [{ name, browser_download_url: downloadUrl }];
  });
  return { tag_name: tagName, html_url: htmlUrl, assets: validAssets };
}

function readCachedRelease(storage: ReleaseStorage, key: string, now: number): Release | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const cached: unknown = JSON.parse(raw);
    if (isRecord(cached) && typeof cached.fetchedAt === "number") {
      const age = now - cached.fetchedAt;
      const release = parseRelease(cached.release);
      if (release && age >= 0 && age < RELEASE_CACHE_TTL_MS) return release;
    }
  } catch {
    // Corrupt entries are discarded below.
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be unavailable; the fetch result is still usable.
  }
  return null;
}

export async function fetchLatestRelease(
  options: {
    readonly repository?: string;
    readonly fetchImpl?: typeof fetch;
    readonly storage?: ReleaseStorage | null;
    readonly now?: () => number;
  } = {},
): Promise<Release> {
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage =
    options.storage === undefined
      ? typeof sessionStorage === "undefined"
        ? null
        : sessionStorage
      : options.storage;
  const now = options.now ?? Date.now;
  const cacheKey = `${CACHE_KEY_PREFIX}${repository}`;

  const cached = storage ? readCachedRelease(storage, cacheKey, now()) : null;
  if (cached) return cached;

  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`Release feed returned HTTP ${response.status}`);
  }
  const release = parseRelease(await response.json());
  if (!release) {
    throw new Error("Release feed returned an unexpected shape");
  }

  try {
    storage?.setItem(
      cacheKey,
      JSON.stringify({ fetchedAt: now(), release } satisfies CachedRelease),
    );
  } catch {
    // Quota or privacy-mode failures only cost a refetch.
  }
  return release;
}

/** Matches `<name>-<version>-<suffix>` assets, e.g. `-arm64.dmg`. */
export function findAssetBySuffix(
  assets: ReadonlyArray<ReleaseAsset>,
  suffix: string,
): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name.endsWith(`-${suffix}`));
}

export type DownloadTarget = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-deb-x64";

export type DownloadAvailability =
  /** Served from the latest stable release by asset suffix. */
  | { readonly kind: "stable"; readonly suffix: string }
  /** A pinned prerelease that `/releases/latest` never returns. */
  | {
      readonly kind: "preview";
      readonly tag: string;
      readonly asset: string;
      readonly note: string;
    }
  | { readonly kind: "unavailable"; readonly note: string };

export const MAC_PREVIEW_TAG = "v0.0.11-computer-use-preview.1";

/**
 * Which platforms currently ship. Kept explicit so a release that lacks a
 * platform's installer shows a status rather than a misleading download.
 */
export const DOWNLOAD_AVAILABILITY: Readonly<Record<DownloadTarget, DownloadAvailability>> = {
  "win-x64": { kind: "stable", suffix: "x64.exe" },
  "mac-arm64": {
    kind: "preview",
    tag: MAC_PREVIEW_TAG,
    asset: "F5-0.0.11-computer-use-preview.1-arm64.dmg",
    note: "Preview: unsigned, not notarized, no automatic updates, replaces F5 (Alpha)",
  },
  "mac-x64": { kind: "unavailable", note: "Not yet available" },
  "linux-x64": { kind: "stable", suffix: "x86_64.AppImage" },
  "linux-deb-x64": { kind: "stable", suffix: "amd64.deb" },
};

export interface ResolvedDownload {
  readonly href: string | null;
  readonly note: string | null;
}

/**
 * `release` is the latest stable release, or `null` when it could not be
 * loaded; only then does a stable download fall back to the releases page.
 */
export function resolveDownload(target: DownloadTarget, release: Release | null): ResolvedDownload {
  const availability = DOWNLOAD_AVAILABILITY[target];
  if (availability.kind === "unavailable") return { href: null, note: availability.note };
  if (availability.kind === "preview")
    return {
      href: `${REPOSITORY_URL}/releases/download/${availability.tag}/${availability.asset}`,
      note: availability.note,
    };
  if (!release) return { href: RELEASES_URL, note: null };
  const asset = findAssetBySuffix(release.assets, availability.suffix);
  return asset
    ? { href: asset.browser_download_url, note: null }
    : { href: null, note: "Not in the latest release" };
}
