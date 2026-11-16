// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CLI_TARGETS } from "@t3tools/shared/cliRelease";
import { desktopReleaseAssets, type ReleaseProfile } from "./release-profile.ts";

/** Mirrors `assemble-release-checksums.ts` for synchronous fixtures. */
export function writeFixtureChecksums(dir: string): void {
  const lines = readdirSync(dir)
    .filter((name) => name !== "SHA256SUMS")
    .sort()
    .map(
      (name) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, name)))
          .digest("hex")}  ${name}`,
    );
  writeFileSync(join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
}

export function createReleaseFixture(profile: ReleaseProfile = "all") {
  const dir = mkdtempSync(join(tmpdir(), "f5-assets-"));

  const version = "0.1.0-beta.1";
  const content = Buffer.from("artifact");
  const hash = (kind: string, encoding: "hex" | "base64") =>
    createHash(kind).update(content).digest(encoding);
  const manifest = (names: readonly string[]) =>
    `version: ${version}\nfiles:\n${names.map((name) => `  - url: ${name}\n    sha512: ${hash("sha512", "base64")}\n    size: ${content.length}\n`).join("")}releaseDate: '2026-10-16T00:00:00Z'\n`;
  const desktop = desktopReleaseAssets(profile, version, "beta");
  for (const name of [...desktop.installers, ...desktop.requiredBlockmaps])
    writeFileSync(join(dir, name), content);
  for (const feed of desktop.feeds)
    writeFileSync(
      join(dir, feed.manifest),
      feed.manifest.endsWith("-linux.yml")
        ? readFileSync(new URL("../fixtures/appimage-update.yml", import.meta.url), "utf8")
        : manifest(feed.installers),
    );

  const artifacts = CLI_TARGETS.map((target) => {
    const name = `f5-${version}-${target}.tar.gz`;
    writeFileSync(join(dir, name), content);
    return {
      target,
      url: `https://github.com/lopes-felipe/f5/releases/download/v${version}/${name}`,
      sha256: hash("sha256", "hex"),
      size: content.length,
    };
  });
  writeFileSync(
    join(dir, "f5-cli-release.json"),
    JSON.stringify({ schemaVersion: 1, version, artifacts }),
  );
  writeFixtureChecksums(dir);
  return { dir, version, profile };
}
