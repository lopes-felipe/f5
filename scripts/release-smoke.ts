import { createReleaseFixture } from "./lib/release-fixture.ts";
import { mergesMacManifests, RELEASE_PROFILES } from "./lib/release-profile.ts";
import {
  parseMacUpdateManifest,
  serializeMacUpdateManifest,
} from "./merge-mac-update-manifests.ts";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspaceFiles = [
  "package.json",
  "bun.lock",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/marketing/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/effect-acp/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  // patchedDependencies entries must resolve, or the lockfile-only install fails.
  cpSync(resolve(repoRoot, "patches"), resolve(targetRoot, "patches"), { recursive: true });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-beta.1
files:
  - url: F5-9.9.9-beta.1-arm64.zip
    sha512: arm64zip
    size: 125621344
  - url: F5-9.9.9-beta.1-arm64.dmg
    sha512: arm64dmg
    size: 131754935
path: F5-9.9.9-beta.1-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-beta.1
files:
  - url: F5-9.9.9-beta.1-x64.zip
    sha512: x64zip
    size: 132000112
  - url: F5-9.9.9-beta.1-x64.dmg
    sha512: x64dmg
    size: 138148807
path: F5-9.9.9-beta.1-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "t3-release-smoke-"));

try {
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-beta.1",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-beta.1"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "F5-9.9.9-beta.1-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "F5-9.9.9-beta.1-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );

  for (const profile of RELEASE_PROFILES) {
    const fixture = createReleaseFixture(profile);
    try {
      if (mergesMacManifests(profile)) {
        const macPath = join(fixture.dir, "beta-mac.yml");
        const mac = parseMacUpdateManifest(readFileSync(macPath, "utf8"), macPath);
        const x64 = join(fixture.dir, "beta-mac-x64.yml");
        writeFileSync(
          macPath,
          serializeMacUpdateManifest({
            ...mac,
            files: mac.files.filter((file) => file.url.includes("arm64")),
          }),
        );
        writeFileSync(
          x64,
          serializeMacUpdateManifest({
            ...mac,
            files: mac.files.filter((file) => file.url.includes("x64")),
          }),
        );
        execFileSync(process.execPath, [
          resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"),
          macPath,
          x64,
        ]);
        rmSync(x64);
      }
      const cliPath = join(fixture.dir, "f5-cli-release.json");
      const cli = JSON.parse(readFileSync(cliPath, "utf8")) as {
        schemaVersion: number;
        version: string;
        artifacts: { target: string }[];
      };
      const fragments = cli.artifacts.map((artifact) => {
        const path = join(fixture.dir, `f5-${artifact.target}.json`);
        writeFileSync(path, JSON.stringify({ ...cli, artifacts: [artifact] }));
        return path;
      });
      rmSync(cliPath);
      execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/merge-cli-release-manifests.ts"),
        cliPath,
        ...fragments,
      ]);
      for (const path of fragments) rmSync(path);
      execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/assemble-release-checksums.ts"),
        fixture.dir,
      ]);
      execFileSync(process.execPath, [
        resolve(repoRoot, "scripts/verify-release-assets.ts"),
        "--version",
        fixture.version,
        "--channel",
        "beta",
        "--profile",
        profile,
        fixture.dir,
      ]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
