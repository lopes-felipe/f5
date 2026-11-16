import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReleaseProfileAllowed,
  desktopBuildMatrix,
  desktopReleaseAssets,
  mergesMacManifests,
  readCheckedInReleaseProfile,
  resolveReleaseProfile,
} from "./lib/release-profile.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const preview = {
  tag_name: "v0.0.11-computer-use-preview.1",
  draft: false,
  assets: [
    { name: "F5-0.0.11-computer-use-preview.1-arm64.dmg" },
    { name: "F5-0.0.11-computer-use-preview.1-arm64.zip" },
    { name: "preview-verification.json" },
    { name: "SHA256SUMS" },
  ],
};
const windowsRelease = {
  tag_name: "v0.1.0",
  draft: false,
  assets: [{ name: "F5-0.1.0-x64.exe" }, { name: "latest.yml" }],
};

describe("desktop release profiles", () => {
  it("builds only the Windows installer for the windows profile", () => {
    expect(desktopBuildMatrix("windows")).toEqual({
      include: [{ os: "windows-latest", platform: "win", arch: "x64", target: "nsis" }],
    });
    expect(mergesMacManifests("windows")).toBe(false);
    expect(desktopReleaseAssets("windows", "0.1.0", "latest")).toEqual({
      feeds: [{ manifest: "latest.yml", installers: ["F5-0.1.0-x64.exe"] }],
      installers: ["F5-0.1.0-x64.exe"],
      requiredBlockmaps: ["F5-0.1.0-x64.exe.blockmap"],
      optionalBlockmaps: [],
    });
  });
  it("keeps the complete four-job matrix and three feeds for all", () => {
    expect(desktopReleaseAssets("all", "1.0.0", "beta").installers).toContain("F5-1.0.0-amd64.deb");
    expect(
      desktopBuildMatrix("all").include.map((entry) => `${entry.platform}-${entry.arch}`),
    ).toEqual(["mac-arm64", "mac-x64", "win-x64", "linux-x64"]);
    expect(mergesMacManifests("all")).toBe(true);
    expect(desktopReleaseAssets("all", "1.0.0", "beta").feeds.map((feed) => feed.manifest)).toEqual(
      ["beta-mac.yml", "beta.yml", "beta-linux.yml"],
    );
  });
  it("reads the checked-in profile and only lets dry runs override it", () => {
    const root = mkdtempSync(join(tmpdir(), "f5-profile-"));
    roots.push(root);
    writeFileSync(join(root, "release-profile.json"), JSON.stringify({ desktop: "windows" }));
    const checkedIn = readCheckedInReleaseProfile(root);
    expect(checkedIn).toBe("windows");
    expect(resolveReleaseProfile({ checkedIn, dryRun: false, override: "all" })).toBe("windows");
    expect(resolveReleaseProfile({ checkedIn, dryRun: true, override: "all" })).toBe("all");
    expect(resolveReleaseProfile({ checkedIn, dryRun: true, override: "checked-in" })).toBe(
      "windows",
    );
    expect(() => resolveReleaseProfile({ checkedIn, dryRun: true, override: "mac" })).toThrow();
    writeFileSync(join(root, "release-profile.json"), JSON.stringify({ desktop: "linux" }));
    expect(() => readCheckedInReleaseProfile(root)).toThrow(/Invalid release profile/);
  });
});

describe("Windows-only publication lock", () => {
  it("allows windows with no releases or only the macOS preview", () => {
    assertReleaseProfileAllowed("windows", []);
    assertReleaseProfileAllowed("windows", [preview, windowsRelease]);
  });
  it.each(["latest-mac.yml", "beta-mac.yml", "latest-linux.yml", "beta-linux.yml"])(
    "rejects windows after a published release with %s",
    (name) => {
      const release = { tag_name: "v0.2.0", draft: false, assets: [{ name }] };
      expect(() => assertReleaseProfileAllowed("windows", [preview, release])).toThrow(/"all"/);
      assertReleaseProfileAllowed("all", [preview, release]);
    },
  );
  it("ignores drafts", () => {
    assertReleaseProfileAllowed("windows", [
      { tag_name: "v0.2.0", draft: true, assets: [{ name: "latest-mac.yml" }] },
    ]);
  });
});
