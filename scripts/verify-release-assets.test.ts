import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseAssets, parseReleaseAssetArgs } from "./verify-release-assets.ts";
import { createReleaseFixture, writeFixtureChecksums } from "./lib/release-fixture.ts";
import type { ReleaseProfile } from "./lib/release-profile.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(profile: ReleaseProfile = "all") {
  const value = createReleaseFixture(profile);
  roots.push(value.dir);
  return { ...value, verify: () => verifyReleaseAssets(value.dir, value.version, "beta", profile) };
}

it.each(["all", "windows"] as const)("accepts a complete verified %s release", (profile) => {
  fixture(profile).verify();
});
it.each([
  "F5-0.1.0-beta.1-amd64.deb",
  "F5-0.1.0-beta.1-arm64.dmg",
  "f5-0.1.0-beta.1-linux-arm64.tar.gz",
  "f5-cli-release.json",
])("rejects missing %s", (name) => {
  const f = fixture();
  rmSync(join(f.dir, name));
  expect(f.verify).toThrow(/Missing/);
});
it.each([
  "F5-0.1.0-beta.1-x64.exe",
  "F5-0.1.0-beta.1-x64.exe.blockmap",
  "beta.yml",
  "f5-0.1.0-beta.1-win32-arm64.tar.gz",
  "f5-cli-release.json",
  "SHA256SUMS",
])("rejects a windows release missing %s", (name) => {
  const f = fixture("windows");
  rmSync(join(f.dir, name));
  expect(f.verify).toThrow(/Missing/);
});
it.each(["F5-0.1.0-beta.1-arm64.dmg", "beta-mac.yml", "F5-0.1.0-beta.1-x86_64.AppImage"])(
  "rejects %s in a windows release",
  (name) => {
    const f = fixture("windows");
    writeFileSync(join(f.dir, name), "artifact");
    writeFixtureChecksums(f.dir);
    expect(f.verify).toThrow(/Unexpected asset/);
  },
);
it("rejects unknown files", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "extra"), "");
  expect(f.verify).toThrow(/Unexpected/);
});
it.each(["F5-0.1.0-beta.1-x64.exe", "f5-0.1.0-beta.1-win32-arm64.tar.gz"])(
  "checks size and hash for %s",
  (name) => {
    const f = fixture();
    writeFileSync(join(f.dir, name), "corrupt");
    expect(f.verify).toThrow(/mismatch/);
  },
);
it("rejects wrong manifest versions and CLI URLs", () => {
  const f = fixture();
  const path = join(f.dir, "beta.yml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("version: 0.1.0-beta.1", "version: 9.9.9"),
  );
  expect(f.verify).toThrow(/Version/);
  const other = fixture();
  const cli = join(other.dir, "f5-cli-release.json");
  writeFileSync(
    cli,
    readFileSync(cli, "utf8").replace("https://github.com", "https://evil.example"),
  );
  expect(other.verify).toThrow();
});

it("rejects same-size content with the wrong hash", () => {
  for (const name of ["F5-0.1.0-beta.1-x64.exe", "f5-0.1.0-beta.1-win32-arm64.tar.gz"]) {
    const f = fixture();
    writeFileSync(join(f.dir, name), "artifacx");
    expect(f.verify).toThrow(/mismatch/);
  }
});

describe("SHA256SUMS contents", () => {
  const sums = (dir: string) => join(dir, "SHA256SUMS");
  it("rejects a wrong hash", () => {
    const f = fixture("windows");
    const text = readFileSync(sums(f.dir), "utf8");
    writeFileSync(sums(f.dir), text.replace(/^[0-9a-f]{64}/, "0".repeat(64)));
    expect(f.verify).toThrow(/SHA256SUMS checksum mismatch/);
  });
  it("rejects a missing line", () => {
    const f = fixture("windows");
    const lines = readFileSync(sums(f.dir), "utf8").trimEnd().split("\n");
    writeFileSync(
      sums(f.dir),
      lines.filter((line) => !line.endsWith(".blockmap")).join("\n") + "\n",
    );
    expect(f.verify).toThrow(/SHA256SUMS is missing asset: F5-0.1.0-beta.1-x64.exe.blockmap/);
  });
  it("rejects extra, duplicate, self and malformed lines", () => {
    const f = fixture("windows");
    const text = readFileSync(sums(f.dir), "utf8");
    const first = text.split("\n")[0]!;
    for (const [content, error] of [
      [`${text}${"a".repeat(64)}  F5-0.1.0-beta.1-arm64.dmg\n`, /unexpected asset/],
      [`${text}${first}\n`, /twice/],
      [`${text}${"a".repeat(64)}  SHA256SUMS\n`, /must not list itself/],
      [`${text}not a checksum\n`, /Malformed/],
      [text.trimEnd(), /newline/],
      ["", /newline/],
    ] as const) {
      writeFileSync(sums(f.dir), content);
      expect(f.verify).toThrow(error);
    }
  });
});

it("accepts the AppImage manifest emitted by electron-builder 26.15.3 including blockMapSize", () => {
  const f = fixture();
  const manifest = readFileSync(join(f.dir, "beta-linux.yml"), "utf8");
  expect(manifest).toContain("    blockMapSize: 3");
  expect(manifest).toContain("path: F5-0.1.0-beta.1-x86_64.AppImage");
  f.verify();
});
it("rejects corrupted AppImage manifests and validates argument names", () => {
  const f = fixture();
  const path = join(f.dir, "beta-linux.yml");
  writeFileSync(path, readFileSync(path, "utf8").replace("blockMapSize: 3", "blockMapSize: 300"));
  expect(f.verify).toThrow(/blockMapSize/);
  expect(
    parseReleaseAssetArgs([
      "--channel",
      "beta",
      f.dir,
      "--version",
      f.version,
      "--profile",
      "windows",
    ]),
  ).toEqual({ dir: f.dir, version: f.version, channel: "beta", profile: "windows" });
  expect(() =>
    parseReleaseAssetArgs(["--not-version", f.version, "--channel", "beta", f.dir]),
  ).toThrow();
  expect(() => parseReleaseAssetArgs(["--version", f.version, "--channel", "beta", f.dir])).toThrow(
    /--profile/,
  );
  expect(() =>
    parseReleaseAssetArgs(["--version", f.version, "--channel", "beta", "--profile", "mac", f.dir]),
  ).toThrow(/Invalid release profile/);
});
