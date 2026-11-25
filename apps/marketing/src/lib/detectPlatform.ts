import { resolveDownload, type DownloadTarget, type Release } from "./releases";

export interface DetectedPlatform {
  readonly os: "mac" | "win" | "linux";
  /** Direct download target when architecture is known; `null` routes to `/download`. */
  readonly target: DownloadTarget | null;
  readonly label: string;
}

export interface HeroDownloadCta {
  readonly os: "mac" | "win" | "linux" | null;
  readonly label: string;
  readonly href: string;
}

const ARM_HINT_RE = /\b(arm|aarch64|arm64)\b/i;
const X86_HINT_RE = /\b(x86|amd64|x64|x86_64|i[36]86)\b/i;

/**
 * Maps a browser user-agent string and optional Client Hints architecture
 * (`navigator.userAgentData.getHighEntropyValues(["architecture"])`) to a
 * desktop download CTA.
 *
 * Mobile and ChromeOS user agents often include "Linux" or "Mac OS X", so they
 * are excluded before desktop matching. Macs whose architecture cannot be
 * detected and ARM Linux desktops route to `/download` (`target: null`) so
 * visitors are never handed an incompatible binary.
 */
export function detectPlatform(
  ua: string,
  architecture?: string | null,
  maxTouchPoints = 0,
): DetectedPlatform | null {
  const arch = architecture?.trim() ?? "";

  if (/(Android|CrOS|iPhone|iPad|iPod)/i.test(ua)) {
    return null;
  }

  if (/Win/i.test(ua)) {
    return { os: "win", target: "win-x64", label: "Download for Windows" };
  }

  if (/Mac/i.test(ua)) {
    // iPadOS 13+ desktop-class Safari reports a Mac user agent with multi-touch.
    if (maxTouchPoints > 1) {
      return null;
    }
    if (ARM_HINT_RE.test(arch)) {
      return { os: "mac", target: "mac-arm64", label: "Download for macOS (Apple Silicon)" };
    }
    if (X86_HINT_RE.test(arch)) {
      return { os: "mac", target: "mac-x64", label: "Download for macOS (Intel)" };
    }
    // Browsers without Client Hints (Safari, Firefox) cannot distinguish Apple Silicon
    // from Intel; send them to the download page so they can pick the right DMG.
    return { os: "mac", target: null, label: "Download for macOS" };
  }

  if (/Linux/i.test(ua)) {
    // Only x86_64 AppImages ship today; ARM Linux desktops get the download page.
    if (ARM_HINT_RE.test(arch) || ARM_HINT_RE.test(ua)) {
      return { os: "linux", target: null, label: "Linux: see download options" };
    }
    return { os: "linux", target: "linux-x64", label: "Download for Linux" };
  }

  return null;
}

/** Resolves the hero CTA label, OS icon key, and destination URL for a detected platform. */
export function resolveHeroDownloadCta(
  platform: DetectedPlatform | null,
  release: Release | null,
): HeroDownloadCta {
  if (!platform) {
    return { os: null, label: "Download F5", href: "/download" };
  }
  if (!platform.target) {
    // Without a direct installer for this architecture, the download page explains the options.
    return { os: platform.os, label: platform.label, href: "/download" };
  }
  const { href } = resolveDownload(platform.target, release);
  return {
    os: platform.os,
    label: platform.label,
    href: href ?? "/download",
  };
}
