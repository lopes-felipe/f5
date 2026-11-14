// @effect-diagnostics nodeBuiltinImport:off
// Changelog fragments: one file per entry under changes/<category>/<slug>.md, so parallel PRs
// never edit the same lines. Release preparation folds them into CHANGELOG.md.
// Runs under plain `node` (type stripping) in the Changelog check: keep imports explicit and
// avoid enums or other syntax that needs a transform.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENTS_DIR = "changes";
export const FRAGMENTS_README = FRAGMENTS_DIR + "/README.md";

/** Allowed categories, in the order their `###` headings are written. */
export const CATEGORIES = [
  "added",
  "changed",
  "performance",
  "deprecated",
  "removed",
  "fixed",
  "security",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Fragment {
  path: string;
  category: Category;
  /** Top-level bullets, each with its indented continuation lines. */
  entries: string[];
}

/** Entries of one changelog section, grouped by `###` heading. */
export interface SectionGroups {
  /** Entries before the first `###` heading. */
  preamble: string[];
  known: Map<Category, string[]>;
  /** Sections whose heading is not a known category, in their original order. */
  unknown: { heading: string; entries: string[] }[];
}

const FRAGMENT_PATH = /^changes\/([^/]+)\/([^/]+)$/;
const SLUG = /^[a-z0-9][a-z0-9-]*\.md$/;

export function isFragmentDirPath(path: string): boolean {
  return path.startsWith(FRAGMENTS_DIR + "/");
}

export function headingFor(category: Category): string {
  return "### " + category[0]!.toUpperCase() + category.slice(1);
}

function categoryOf(heading: string): Category | undefined {
  const name = heading
    .replace(/^###\s+/, "")
    .trim()
    .toLowerCase();
  return CATEGORIES.find((category) => category === name);
}

/**
 * The category and slug of a fragment path, or null for changes/README.md. Throws for any other
 * path under changes/, so stray files cannot silently drop out of a release.
 */
export function parseFragmentPath(path: string): { category: Category; slug: string } | null {
  if (path === FRAGMENTS_README) return null;
  if (!isFragmentDirPath(path)) throw new Error(`${path} is not under ${FRAGMENTS_DIR}/`);
  const match = FRAGMENT_PATH.exec(path);
  if (!match) {
    throw new Error(
      `${path}: changelog fragments must be ${FRAGMENTS_DIR}/<category>/<slug>.md, one level deep`,
    );
  }
  const category = CATEGORIES.find((name) => name === match[1]);
  if (!category) {
    throw new Error(`${path}: unknown category "${match[1]}"; use one of ${CATEGORIES.join(", ")}`);
  }
  if (!SLUG.test(match[2]!)) {
    throw new Error(
      `${path}: the file name must be lowercase letters, digits and dashes, ending in .md`,
    );
  }
  return { category, slug: match[2]!.slice(0, -3) };
}

/**
 * Splits lines into entries. A top-level `- ` bullet or heading, or any top-level line after a
 * blank line, starts an entry. Indented lines (with any blank lines between them), lazy
 * continuation lines directly below an entry, and everything inside a fenced code block continue
 * it. Trailing whitespace and blank lines between entries go.
 */
export function splitEntries(lines: readonly string[]): string[] {
  const entries: string[][] = [];
  let blanks = 0;
  let fence: string | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const current = entries.at(-1);
    if (fence !== undefined && current) {
      current.push(line);
      if (line.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    if (line === "") {
      if (current) blanks++;
      continue;
    }
    const continues = /^\s/.test(line) || (blanks === 0 && !/^(- |#)/.test(line));
    if (current && continues) {
      for (; blanks > 0; blanks--) current.push("");
      current.push(line);
    } else {
      entries.push([line]);
    }
    blanks = 0;
    fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  }
  return entries.map((entry) => entry.join("\n"));
}

/** The entries of a fragment, or a clear error describing what is wrong with it. */
export function validateFragment(path: string, content: string): string[] {
  if (parseFragmentPath(path) === null) throw new Error(`${path} is not a changelog fragment`);
  const entries = splitEntries(content.split(/\r?\n/));
  if (entries.length === 0) throw new Error(`${path} is empty; add a "- " bullet`);
  for (const entry of entries) {
    const first = entry.split("\n")[0]!;
    if (first.startsWith("#")) {
      throw new Error(`${path} has a heading ("${first}"); the folder name sets the section`);
    }
    if (!/^- \S/.test(first)) {
      throw new Error(`${path} has text outside a "- " bullet: "${first}"`);
    }
  }
  return entries;
}

/**
 * Times at which each path was last added, from
 * `git log --no-renames --diff-filter=A --name-only --format=@%ct`.
 */
export function parseAddTimes(output: string): Map<string, number> {
  const times = new Map<string, number>();
  let time = Number.NaN;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("@")) time = Number(trimmed.slice(1));
    // git log lists newest first, so the first time seen is the most recent add.
    else if (!times.has(trimmed) && Number.isFinite(time)) times.set(trimmed, time);
  }
  return times;
}

/** Oldest add first; paths without a commit last; ties by path. */
export function orderFragments<T extends { path: string }>(
  fragments: readonly T[],
  addTimes: ReadonlyMap<string, number>,
): T[] {
  const time = (path: string) => addTimes.get(path) ?? Number.POSITIVE_INFINITY;
  return fragments.toSorted(
    (a, b) => time(a.path) - time(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export const ADD_TIMES_ARGS = [
  "log",
  "--no-renames",
  "--diff-filter=A",
  "--name-only",
  "--format=@%ct",
] as const;

function addTimesAt(root: string): Map<string, number> {
  try {
    return parseAddTimes(
      execFileSync("git", ["-C", root, ...ADD_TIMES_ARGS, "--", FRAGMENTS_DIR + "/"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return new Map();
  }
}

/** Every fragment under `root`/changes, validated and in release order. */
export function readFragments(root: string): Fragment[] {
  const dir = join(root, FRAGMENTS_DIR);
  if (!existsSync(dir)) return [];
  // Dotfiles such as .DS_Store are local noise; the Changelog check rejects committed ones.
  const visible = (path: string) => readdirSync(path).filter((name) => !name.startsWith("."));
  const fragments: Fragment[] = [];
  for (const name of visible(dir).toSorted()) {
    const top = FRAGMENTS_DIR + "/" + name;
    if (!statSync(join(dir, name)).isDirectory()) {
      if (parseFragmentPath(top) === null) continue;
      throw new Error(`${top}: changelog fragments must be inside a category folder`);
    }
    for (const file of visible(join(dir, name)).toSorted()) {
      const path = top + "/" + file;
      if (statSync(join(root, path)).isDirectory()) {
        throw new Error(`${path}: changelog fragments must be one level deep`);
      }
      const parsed = parseFragmentPath(path)!;
      fragments.push({
        path,
        category: parsed.category,
        entries: validateFragment(path, readFileSync(join(root, path), "utf8")),
      });
    }
  }
  return orderFragments(fragments, addTimesAt(root));
}

export type Git = (args: readonly string[]) => string;
export type Show = (rev: string, path: string) => string | undefined;

/** Paths of every file under changes/ at `rev`. */
export function fragmentPathsAt(rev: string, git: Git): string[] {
  return git(["ls-tree", "-r", "--name-only", rev, "--", FRAGMENTS_DIR + "/"])
    .split("\n")
    .map((line) => line.trim())
    .filter(isFragmentDirPath);
}

/**
 * The fragments at `rev` (all of them, or only `paths`), in release order using add times from
 * `timesRange` (default `rev`). Release publication must not fail over a malformed fragment, which
 * the Changelog check already rejects, so invalid ones are skipped with a warning.
 */
export function fragmentsAt(input: {
  rev: string;
  paths?: readonly string[];
  timesRange?: string;
  git: Git;
  show: Show;
  warn: (message: string) => void;
}): Fragment[] {
  const { rev, git, show, warn } = input;
  const fragments: Fragment[] = [];
  for (const path of input.paths ?? fragmentPathsAt(rev, git)) {
    if (!isFragmentDirPath(path)) continue;
    try {
      const parsed = parseFragmentPath(path);
      if (parsed === null) continue;
      const entries = validateFragment(path, show(rev, path) ?? "");
      fragments.push({ path, category: parsed.category, entries });
    } catch (error) {
      warn("Skipping changelog fragment: " + (error as Error).message);
    }
  }
  if (fragments.length === 0) return [];
  const range = input.timesRange ?? rev;
  return orderFragments(
    fragments,
    parseAddTimes(git([...ADD_TIMES_ARGS, range, "--", FRAGMENTS_DIR + "/"])),
  );
}

/** Top-level bullet lines of every fragment at `rev`. */
export function fragmentBulletLinesAt(rev: string, git: Git): string[] {
  try {
    const pathspec = [FRAGMENTS_DIR + "/", ":(exclude)" + FRAGMENTS_README];
    return git(["grep", "-h", "-I", "--no-color", "-e", "^- ", rev, "--", ...pathspec])
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => /^- \S/.test(line));
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: unknown }).status === 1) return [];
    throw error;
  }
}

/** Removes entries whose first line is in `existing`, dropping fragments left empty. */
export function withoutExisting(
  fragments: readonly Fragment[],
  existing: ReadonlySet<string>,
): Fragment[] {
  return fragments
    .map((fragment) => ({
      ...fragment,
      entries: fragment.entries.filter((entry) => !existing.has(entry.split("\n")[0]!)),
    }))
    .filter((fragment) => fragment.entries.length > 0);
}

export function lineSet(...texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap((text) => text.split(/\r?\n/).map((line) => line.trimEnd())));
}

export function emptyGroups(): SectionGroups {
  return { preamble: [], known: new Map(), unknown: [] };
}

/** Groups a section's lines (between its `## ` heading and the next) by `###` heading. */
export function parseSection(lines: readonly string[]): SectionGroups {
  const groups = emptyGroups();
  let heading: string | undefined;
  let body: string[] = [];
  const flush = () => {
    const entries = splitEntries(body);
    if (heading === undefined) groups.preamble.push(...entries);
    else {
      const category = categoryOf(heading);
      if (category) groups.known.set(category, [...(groups.known.get(category) ?? []), ...entries]);
      else groups.unknown.push({ heading, entries });
    }
    body = [];
  };
  for (const line of lines) {
    if (/^###\s/.test(line)) {
      flush();
      heading = line.trimEnd();
    } else body.push(line);
  }
  flush();
  return groups;
}

/** Appends fragment entries after the section's existing entries of the same category. */
export function addFragments(groups: SectionGroups, fragments: readonly Fragment[]): SectionGroups {
  const known = new Map(groups.known);
  for (const fragment of fragments) {
    known.set(fragment.category, [...(known.get(fragment.category) ?? []), ...fragment.entries]);
  }
  return { preamble: [...groups.preamble], known, unknown: [...groups.unknown] };
}

/** Keeps only entries whose first line is not in `existing`. */
export function newEntries(groups: SectionGroups, existing: ReadonlySet<string>): SectionGroups {
  const fresh = (entries: readonly string[]) =>
    entries.filter((entry) => !existing.has(entry.split("\n")[0]!));
  return {
    preamble: fresh(groups.preamble),
    known: new Map([...groups.known].map(([category, entries]) => [category, fresh(entries)])),
    unknown: groups.unknown.map(({ heading, entries }) => ({ heading, entries: fresh(entries) })),
  };
}

export function isEmpty(groups: SectionGroups): boolean {
  return renderSection(groups) === "";
}

function joinEntries(entries: readonly string[]): string {
  return entries
    .map((entry, index) => {
      if (index === 0) return entry;
      const tight = entry.startsWith("- ") && entries[index - 1]!.startsWith("- ");
      return (tight ? "\n" : "\n\n") + entry;
    })
    .join("");
}

/** Renders grouped entries with known categories in canonical order, then unknown sections. */
export function renderSection(groups: SectionGroups): string {
  const blocks: string[] = [];
  if (groups.preamble.length > 0) blocks.push(joinEntries(groups.preamble));
  for (const category of CATEGORIES) {
    const entries = groups.known.get(category) ?? [];
    if (entries.length > 0) blocks.push(headingFor(category) + "\n\n" + joinEntries(entries));
  }
  for (const { heading, entries } of groups.unknown) {
    if (entries.length > 0) blocks.push(heading + "\n\n" + joinEntries(entries));
  }
  return blocks.join("\n\n");
}

/** Line range of the `## [Unreleased]` body: from after its heading to the next `## ` heading. */
export function unreleasedRange(lines: readonly string[]): { start: number; end: number } | null {
  const heading = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (heading === -1) return null;
  const next = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  return { start: heading + 1, end: next === -1 ? lines.length : next };
}

/** The `## [Unreleased]` section of a changelog, grouped by heading. */
export function unreleasedGroups(changelog: string): SectionGroups {
  const lines = changelog.split(/\r?\n/);
  const range = unreleasedRange(lines);
  return range ? parseSection(lines.slice(range.start, range.end)) : emptyGroups();
}

const bulletLines = (lines: readonly string[]) =>
  lines.filter((line) => /^- \S/.test(line)).map((line) => line.trimEnd());

/** Top-level bullets between `## [Unreleased]` and the next release heading. */
export function unreleasedBullets(changelog: string): string[] {
  const lines = changelog.split(/\r?\n/);
  const range = unreleasedRange(lines);
  return range ? bulletLines(lines.slice(range.start, range.end)) : [];
}

/** Unreleased bullets in `after` that `before` had nowhere, in any section. */
export function newUnreleasedBullets(before: string, after: string): string[] {
  const existing = new Set(bulletLines(before.split(/\r?\n/)));
  return unreleasedBullets(after).filter((bullet) => !existing.has(bullet));
}
