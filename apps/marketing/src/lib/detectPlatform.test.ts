import { describe, expect, it } from "vitest";

import { detectPlatform, resolveHeroDownloadCta } from "./detectPlatform";
import type { Release } from "./releases";

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/lopes-felipe/f5/releases/download/v0.1.11/${name}`,
});

const RELEASE: Release = {
  tag_name: "v0.1.11",
  html_url: "https://github.com/lopes-felipe/f5/releases/tag/v0.1.11",
  assets: [
    asset("F5-0.1.11-arm64.dmg"),
    asset("F5-0.1.11-x64.dmg"),
    asset("F5-0.1.11-x64.exe"),
    asset("F5-0.1.11-x86_64.AppImage"),
    asset("F5-0.1.11-amd64.deb"),
  ],
};

describe("detectPlatform and resolveHeroDownloadCta", () => {
  it("routes Windows visitors to the x64 installer", () => {
    const platform = detectPlatform(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "x86",
    );
    expect(resolveHeroDownloadCta(platform, RELEASE)).toEqual({
      os: "win",
      label: "Download for Windows",
      href: "https://github.com/lopes-felipe/f5/releases/download/v0.1.11/F5-0.1.11-x64.exe",
    });
  });

  it("routes Apple Silicon Macs to the stable arm64 DMG", () => {
    const platform = detectPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "arm",
    );
    expect(resolveHeroDownloadCta(platform, RELEASE)).toEqual({
      os: "mac",
      label: "Download for macOS (Apple Silicon)",
      href: "https://github.com/lopes-felipe/f5/releases/download/v0.1.11/F5-0.1.11-arm64.dmg",
    });
  });

  it("routes Intel Macs to the stable x64 DMG when Client Hints report x86", () => {
    const platform = detectPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "x86",
    );
    expect(resolveHeroDownloadCta(platform, RELEASE)).toEqual({
      os: "mac",
      label: "Download for macOS (Intel)",
      href: "https://github.com/lopes-felipe/f5/releases/download/v0.1.11/F5-0.1.11-x64.dmg",
    });
  });

  it("routes Macs with unknown architecture (Safari/Firefox) to /download", () => {
    const platform = detectPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      null,
    );
    expect(resolveHeroDownloadCta(platform, RELEASE)).toEqual({
      os: "mac",
      label: "Download for macOS",
      href: "/download",
    });
  });

  it("excludes iPadOS (both classic and desktop-mode Safari)", () => {
    const classic = detectPlatform(
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    );
    expect(classic).toBeNull();
    expect(resolveHeroDownloadCta(classic, RELEASE)).toEqual({
      os: null,
      label: "Download F5",
      href: "/download",
    });

    const desktopMode = detectPlatform(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      null,
      5,
    );
    expect(desktopMode).toBeNull();
  });

  it("routes x86_64 Linux desktops to the AppImage and ARM Linux desktops to /download", () => {
    const linuxX64 = detectPlatform(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "x86",
    );
    expect(resolveHeroDownloadCta(linuxX64, RELEASE)).toEqual({
      os: "linux",
      label: "Download for Linux",
      href: "https://github.com/lopes-felipe/f5/releases/download/v0.1.11/F5-0.1.11-x86_64.AppImage",
    });

    const linuxArmUa = detectPlatform(
      "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
    );
    expect(resolveHeroDownloadCta(linuxArmUa, RELEASE)).toEqual({
      os: "linux",
      label: "Linux: see download options",
      href: "/download",
    });

    const linuxArmHint = detectPlatform(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "arm",
    );
    expect(resolveHeroDownloadCta(linuxArmHint, RELEASE)).toEqual({
      os: "linux",
      label: "Linux: see download options",
      href: "/download",
    });
  });

  it("never hands Android or ChromeOS visitors a desktop Linux AppImage", () => {
    const android = detectPlatform(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/135.0.0.0 Mobile Safari/537.36",
    );
    expect(android).toBeNull();
    expect(resolveHeroDownloadCta(android, RELEASE)).toEqual({
      os: null,
      label: "Download F5",
      href: "/download",
    });

    const chromeOs = detectPlatform(
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36",
      "x86",
    );
    expect(chromeOs).toBeNull();
    expect(resolveHeroDownloadCta(chromeOs, RELEASE)).toEqual({
      os: null,
      label: "Download F5",
      href: "/download",
    });
  });
});
