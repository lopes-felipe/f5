import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RELEASE_REPOSITORY, resolveReleaseRepository } from "./releaseRepository";
import {
  RELEASE_CACHE_TTL_MS,
  fetchLatestRelease,
  DOWNLOAD_AVAILABILITY,
  MAC_PREVIEW_TAG,
  RELEASES_URL,
  parseRelease,
  resolveDownload,
  type Release,
} from "./releases";

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/lopes-felipe/f5/releases/download/v1.2.3/${name}`,
});

const RELEASE: Release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/lopes-felipe/f5/releases/tag/v1.2.3",
  assets: [
    asset("T3-Code-1.2.3-arm64.dmg"),
    asset("T3-Code-1.2.3-x64.dmg"),
    asset("T3-Code-1.2.3-x64.exe"),
    asset("T3-Code-1.2.3-x86_64.AppImage"),
  ],
};

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("resolveReleaseRepository", () => {
  it("defaults to the F5 repository and rejects malformed values", () => {
    expect(resolveReleaseRepository(undefined)).toBe(DEFAULT_RELEASE_REPOSITORY);
    expect(resolveReleaseRepository("  ")).toBe(DEFAULT_RELEASE_REPOSITORY);
    expect(resolveReleaseRepository("acme/f5-fork")).toBe("acme/f5-fork");
    for (const invalid of ["acme", "acme/f5/extra", "https://github.com/acme/f5", "acme/.."]) {
      expect(() => resolveReleaseRepository(invalid)).toThrow(/owner\/name/);
    }
  });
});

describe("fetchLatestRelease", () => {
  it("fetches from the configured repository and caches a validated release", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => jsonResponse(RELEASE));
    const release = await fetchLatestRelease({
      repository: "lopes-felipe/f5",
      fetchImpl,
      storage,
      now: () => 1_000,
    });
    expect(release).toEqual(RELEASE);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/lopes-felipe/f5/releases/latest",
      expect.anything(),
    );

    const again = await fetchLatestRelease({
      repository: "lopes-felipe/f5",
      fetchImpl,
      storage,
      now: () => 1_000 + RELEASE_CACHE_TTL_MS - 1,
    });
    expect(again).toEqual(RELEASE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache expires", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => jsonResponse(RELEASE));
    await fetchLatestRelease({ fetchImpl, storage, now: () => 0 });
    await fetchLatestRelease({ fetchImpl, storage, now: () => RELEASE_CACHE_TTL_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("discards a corrupt cache entry and fetches", async () => {
    const storage = memoryStorage({
      "f5-latest-release:v1:lopes-felipe/f5": "{not json",
    });
    const fetchImpl = vi.fn(async () => jsonResponse(RELEASE));
    await expect(
      fetchLatestRelease({ repository: "lopes-felipe/f5", fetchImpl, storage, now: () => 0 }),
    ).resolves.toEqual(RELEASE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    storage.values.set(
      "f5-latest-release:v1:lopes-felipe/f5",
      JSON.stringify({ fetchedAt: 0, release: { tag_name: 1 } }),
    );
    await fetchLatestRelease({ repository: "lopes-felipe/f5", fetchImpl, storage, now: () => 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects non-200 responses and unexpected shapes without caching", async () => {
    const storage = memoryStorage();
    await expect(
      fetchLatestRelease({
        fetchImpl: async () => jsonResponse({ message: "API rate limit exceeded" }, 403),
        storage,
      }),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      fetchLatestRelease({ fetchImpl: async () => jsonResponse({ message: "nope" }), storage }),
    ).rejects.toThrow(/unexpected shape/);
    expect(storage.values.size).toBe(0);
  });
});

describe("parseRelease", () => {
  it("drops assets with unexpected names or non-GitHub URLs", () => {
    const parsed = parseRelease({
      ...RELEASE,
      assets: [
        ...RELEASE.assets,
        { name: "evil.dmg", browser_download_url: "https://example.com/evil.dmg" },
        { name: "../x.dmg", browser_download_url: RELEASE.assets[0]!.browser_download_url },
        "not an asset",
      ],
    });
    expect(parsed?.assets).toEqual(RELEASE.assets);
    expect(parseRelease({ ...RELEASE, html_url: "javascript:alert(1)" })).toBeNull();
  });
});

describe("resolveDownload", () => {
  it("links the Windows installer from the latest stable release", () => {
    expect(resolveDownload("win-x64", RELEASE)).toEqual({
      href: "https://github.com/lopes-felipe/f5/releases/download/v1.2.3/T3-Code-1.2.3-x64.exe",
      note: null,
    });
  });
  it("shows a status instead of the releases page when the asset is missing", () => {
    expect(resolveDownload("win-x64", { ...RELEASE, assets: [] })).toEqual({
      href: null,
      note: "Not in the latest release",
    });
  });
  it("falls back to the releases page only when the release cannot be loaded", () => {
    expect(resolveDownload("win-x64", null).href).toBe(RELEASES_URL);
  });
  it("pins the labelled macOS preview regardless of the latest release", () => {
    for (const release of [RELEASE, null]) {
      const download = resolveDownload("mac-arm64", release);
      expect(download.href).toBe(
        `https://github.com/lopes-felipe/f5/releases/download/${MAC_PREVIEW_TAG}/F5-0.0.11-computer-use-preview.1-arm64.dmg`,
      );
      expect(download.note).toMatch(/^Preview: unsigned, not notarized/);
    }
  });
  it("never links platforms without an installer, even if a release carries one", () => {
    for (const target of ["mac-x64"] as const)
      expect(resolveDownload(target, RELEASE)).toEqual({ href: null, note: "Not yet available" });
  });
  it("links the AppImage from the same stable release as Debian packages", () => {
    expect(resolveDownload("linux-x64", RELEASE).href).toBe(
      RELEASE.assets.find((entry) => entry.name.endsWith(".AppImage"))?.browser_download_url,
    );
  });
  it("covers every download target", () => {
    expect(Object.keys(DOWNLOAD_AVAILABILITY).sort()).toEqual([
      "linux-deb-x64",
      "linux-x64",
      "mac-arm64",
      "mac-x64",
      "win-x64",
    ]);
  });
  it("links Debian packages only when the release contains one", () => {
    const deb = asset("F5-1.2.3-amd64.deb");
    expect(resolveDownload("linux-deb-x64", RELEASE).href).toBeNull();
    expect(
      resolveDownload("linux-deb-x64", { ...RELEASE, assets: [...RELEASE.assets, deb] }).href,
    ).toBe(deb.browser_download_url);
  });
});
