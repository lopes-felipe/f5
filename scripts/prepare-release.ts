// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCliReleaseVersions, versionToken } from "@t3tools/shared/cliRelease";
import {
  FRAGMENTS_DIR,
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
/** Fragments that already shipped in a published stable release, and that release's version. */
export interface ShippedFragments {
  version: string;
  fragments: readonly Fragment[];
}

const sectionHeading = (version: string) => (line: string) =>
  line === `## [${version}]` || line.startsWith(`## [${version}] `);

/** Appends fragment entries to the existing `## [version]` section, keeping its heading line. */
export function foldIntoRelease(
  text: string,
  version: string,
  fragments: readonly Fragment[],
): string {
  if (fragments.length === 0) return text;
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex(sectionHeading(version));
  if (heading === -1) throw new Error(`Missing changelog section ${version}`);
  const next = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  const end = next === -1 ? lines.length : next;
  const section = renderSection(
    addFragments(parseSection(lines.slice(heading + 1, end)), fragments),
  );
  return [...lines.slice(0, heading + 1), "", section, "", ...lines.slice(end)].join("\n");
}

/**
 * Moves the Unreleased entries and the changelog fragments into a new `## [version] - date`
 * section, grouped by category, and leaves Unreleased empty. Fragments that already shipped in
 * an earlier stable release (they landed while its preparation PR was open) go into that
 * release's section instead. Betas keep everything unreleased.
 */
export function prepareChangelog(
  text: string,
  version: string,
  date: string,
  fragments: readonly Fragment[] = [],
  shipped?: ShippedFragments,
): string {
  if (version.includes("-")) return text;
  if (!/^## \[Unreleased\]\s*$/m.test(text))
    throw new Error("Missing Unreleased changelog section");
  const lines = (shipped ? foldIntoRelease(text, shipped.version, shipped.fragments) : text).split(
    /\r?\n/,
  );
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

function gitIn(root: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Splits fragments into those still pending and those that already shipped: present, unchanged
 * in path, at the newest stable tag merged into HEAD. Release preparation deletes every fragment
 * it folds, so a fragment at that tag landed while the preparation PR was open and shipped with
 * that release.
 */
export function splitShippedFragments(
  root: string,
  fragments: readonly Fragment[],
): { pending: Fragment[]; shipped?: ShippedFragments } {
  const tag = (gitIn(root, ["tag", "--list", "--merged", "HEAD"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .toSorted((a, b) => compareCliReleaseVersions(b.slice(1), a.slice(1)))[0];
  if (!tag || fragments.length === 0) return { pending: [...fragments] };
  const atTag = new Set(
    (gitIn(root, ["ls-tree", "-r", "--name-only", tag, "--", FRAGMENTS_DIR + "/"]) ?? "")
      .split("\n")
      .map((line) => line.trim()),
  );
  const version = tag.slice(1);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/\r?\n/);
  const shipped = fragments.filter((fragment) => atTag.has(fragment.path));
  // Without its section (never expected), keep the entries rather than lose them.
  if (shipped.length === 0 || !changelog.some(sectionHeading(version))) {
    return { pending: [...fragments] };
  }
  return {
    pending: fragments.filter((fragment) => !atTag.has(fragment.path)),
    shipped: { version, fragments: shipped },
  };
}

/**
 * Writes the release section into `root`/CHANGELOG.md and deletes the fragments it folded in.
 * Every fragment is validated before any file changes. Returns the deleted fragment paths;
 * betas change nothing.
 */
export function releaseChangelog(root: string, version: string, date: string): string[] {
  if (version.includes("-")) return [];
  const file = join(root, "CHANGELOG.md");
  const fragments = readFragments(root);
  const { pending, shipped } = splitShippedFragments(root, fragments);
  writeFileSync(
    file,
    prepareChangelog(readFileSync(file, "utf8"), version, date, pending, shipped),
  );
  for (const fragment of fragments) rmSync(join(root, fragment.path));
  return fragments.map((fragment) => fragment.path);
}

/**
 * Recovery for an unpublished stable version: folds fragments that landed after its preparation
 * into its existing section and deletes them. Returns the deleted fragment paths.
 */
export function refoldChangelog(root: string, version: string): string[] {
  const file = join(root, "CHANGELOG.md");
  const fragments = readFragments(root);
  writeFileSync(file, foldIntoRelease(readFileSync(file, "utf8"), version, fragments));
  for (const fragment of fragments) rmSync(join(root, fragment.path));
  return fragments.map((fragment) => fragment.path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? "";
  const current = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version as string;
  validateReleaseVersion(version, current);
  // The changelog step validates every fragment and the Unreleased section before any file changes.
  releaseChangelog(".", version, new Date().toISOString().slice(0, 10));
  updateReleasePackageVersions(version);
  const install = spawnSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("Lockfile update failed");
  console.log(
    `git switch -c release/${version}\ngit add apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json bun.lock CHANGELOG.md changes\ngit commit -m "Release ${version}"\ngit push -u origin release/${version}\ngh pr create --title "Release ${version}" --body "Prepare F5 ${version}."`,
  );
}
