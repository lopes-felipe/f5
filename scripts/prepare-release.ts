// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import {
  addFragments,
  parseSection,
  readFragments,
  renderSection,
  unreleasedRange,
  type Fragment,
} from "./lib/changelog-fragments.ts";
import { updateReleasePackageVersions } from "./update-release-package-versions.ts";
export function validateReleaseVersion(version: string, current: string): void {
  versionToken(version);
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version))
    throw new Error("Only stable and beta.N releases are supported.");
  if (compareCliReleaseVersions(version, current) <= 0)
    throw new Error("Release version must increase.");
}
/**
 * Moves the Unreleased entries and the changelog fragments into a new `## [version] - date`
 * section, grouped by category, and leaves Unreleased empty. Betas keep everything unreleased.
 */
export function prepareChangelog(
  text: string,
  version: string,
  date: string,
  fragments: readonly Fragment[] = [],
): string {
  if (version.includes("-")) return text;
  if (!/^## \[Unreleased\]\s*$/m.test(text))
    throw new Error("Missing Unreleased changelog section");
  const lines = text.split(/\r?\n/);
  const range = unreleasedRange(lines)!;
  const section = renderSection(
    addFragments(parseSection(lines.slice(range.start, range.end)), fragments),
  );
  return [
    ...lines.slice(0, range.start - 1),
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    ...(section ? [section, ""] : []),
    ...lines.slice(range.end),
  ].join("\n");
}

/**
 * Writes the release section into `root`/CHANGELOG.md and deletes the fragments it folded in.
 * Returns the deleted fragment paths; betas change nothing.
 */
export function releaseChangelog(root: string, version: string, date: string): string[] {
  if (version.includes("-")) return [];
  const file = join(root, "CHANGELOG.md");
  const fragments = readFragments(root);
  writeFileSync(file, prepareChangelog(readFileSync(file, "utf8"), version, date, fragments));
  for (const fragment of fragments) rmSync(join(root, fragment.path));
  return fragments.map((fragment) => fragment.path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? "";
  const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version as string;
  validateReleaseVersion(version, current);
  // Validate every fragment before touching any file.
  readFragments(".");
  updateReleasePackageVersions(version);
  releaseChangelog(".", version, new Date().toISOString().slice(0, 10));
  const install = spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("Lockfile update failed");
  console.log(
    `git switch -c release/${version}\ngit add apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json bun.lock CHANGELOG.md changes\ngit commit -m "Release ${version}"\ngit push -u origin release/${version}\ngh pr create --title "Release ${version}" --body "Prepare F5 ${version}."`,
  );
}
