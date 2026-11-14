// Release notes for GitHub releases.
// - Stable: the version's CHANGELOG.md section, plus fragments that landed on main while the
//   preparation PR was open (they ship with this release; the next preparation folds them into
//   this section).
// - Beta: the changelog entries added since the previous published release. The desktop updater
//   shows every intermediate release's notes in a row, so per-beta changes stack up there without
//   repeating entries.
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import {
  FRAGMENTS_DIR,
  addFragments,
  emptyGroups,
  fragmentBulletLinesAt,
  fragmentsAt,
  lineSet,
  newEntries,
  parseSection,
  renderSection,
  unreleasedGroups,
  withoutExisting,
  type Fragment,
  type Git,
  type SectionGroups,
  type Show,
} from "../lib/changelog-fragments.ts";

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

/**
 * The newest published stable or beta tag, other than `currentTag`, whose commit is an ancestor
 * of the candidate. Drafts (unpublished or superseded betas) never count.
 */
export function previousReleaseTag(
  releases: readonly { tag_name: string; draft: boolean }[],
  currentTag: string,
  isAncestor: (tag: string) => boolean,
): string | undefined {
  const tags = releases
    .filter((release) => !release.draft && RELEASE_TAG.test(release.tag_name))
    .map((release) => release.tag_name)
    .filter((tag) => tag !== currentTag)
    .toSorted((a, b) => compareCliReleaseVersions(b.slice(1), a.slice(1)));
  return tags.find(isAncestor);
}

/** Whether release tag `name` points at an ancestor of `sha`, fetching the tag when missing. */
export function isAncestorTag(name: string, sha: string, git: Git): boolean {
  const ref = "refs/tags/" + name;
  try {
    git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
  } catch {
    git(["fetch", "--no-tags", "origin", ref + ":" + ref]);
  }
  try {
    git(["merge-base", "--is-ancestor", ref, sha]);
    return true;
  } catch (error) {
    // merge-base --is-ancestor exits 1 for "not an ancestor"; anything else is a real failure.
    if ((error as { status?: unknown }).status === 1) return false;
    throw error;
  }
}

export interface BetaChanges {
  /** Unreleased CHANGELOG.md entries the previous release did not have. */
  legacy: SectionGroups;
  fragments: Fragment[];
}

/**
 * Collects the changelog entries added between `previousTag` (or the beginning) and the source.
 * An entry counts as new only when its first line appears nowhere in the previous release, neither
 * in its CHANGELOG.md nor in its fragments. That keeps entries from being announced again when a
 * fragment is renamed, migrated into or out of CHANGELOG.md, or folded back into Unreleased by a
 * withdrawn stable preparation.
 */
export function collectBetaChanges(input: {
  sourceSha: string;
  previousTag: string | undefined;
  git: Git;
  show: Show;
  warn?: (message: string) => void;
}): BetaChanges {
  const { sourceSha, previousTag, git, show } = input;
  const warn = input.warn ?? console.warn;
  const base = previousTag === undefined ? undefined : "refs/tags/" + previousTag;
  const dir = FRAGMENTS_DIR + "/";
  const paths = base
    ? git(["diff", "--no-renames", "--diff-filter=A", "--name-only", base, sourceSha, "--", dir])
        .split("\n")
        .map((line) => line.trim())
    : undefined;
  const fragments = fragmentsAt({
    rev: sourceSha,
    ...(paths ? { paths } : {}),
    timesRange: base ? base + ".." + sourceSha : sourceSha,
    git,
    show,
    warn,
  });
  const existing = base
    ? lineSet(show(base, "CHANGELOG.md") ?? "", ...fragmentBulletLinesAt(base, git))
    : new Set<string>();
  const after = show(sourceSha, "CHANGELOG.md");
  return {
    legacy: after === undefined ? emptyGroups() : newEntries(unreleasedGroups(after), existing),
    fragments: withoutExisting(fragments, existing),
  };
}

function provenance(sourceSha: string, runUrl: string): string {
  return "Automated beta from " + sourceSha + ".\n\nSource and validation: " + runUrl + "\n";
}

export function betaReleaseNotes(input: {
  previousTag: string | undefined;
  legacy: SectionGroups;
  fragments: readonly Fragment[];
  sourceSha: string;
  runUrl: string;
}): string {
  const section = renderSection(addFragments(input.legacy, input.fragments));
  const since = input.previousTag === undefined ? "" : " since " + input.previousTag;
  const intro = section
    ? input.previousTag === undefined
      ? "Changes in this beta."
      : "Changes" + since + "."
    : "No user-visible changes" + since + ".";
  return (
    [intro, section].filter(Boolean).join("\n\n") +
    "\n\n" +
    provenance(input.sourceSha, input.runUrl)
  );
}

/** The stable notes: the version's CHANGELOG.md section plus any fragments still at the source. */
export function stableReleaseNotes(
  changelog: string,
  version: string,
  lateFragments: readonly Fragment[] = [],
): string {
  const section = changelog.split("## [" + version + "]")[1];
  if (!section) throw new Error("Stable changelog entry missing");
  const body = section
    .split("\n## [")[0]!
    .replace(/^\s*-\s*\d{4}-\d{2}-\d{2}\s*/, "")
    .trim();
  if (lateFragments.length === 0) return body + "\n";
  return renderSection(addFragments(parseSection(body.split("\n")), lateFragments)) + "\n";
}

/**
 * The GitHub release body for a candidate. Notes are best effort: a git failure while collecting
 * fragments falls back to the changelog section (stable) or the provenance lines (beta) instead of
 * blocking a publication whose tag may already exist.
 */
export function releaseNotesFor(input: {
  kind: "stable" | "beta";
  version: string;
  sourceSha: string;
  runUrl: string;
  releases: readonly { tag_name: string; draft: boolean }[];
  git: Git;
  show: Show;
  warn?: (message: string) => void;
}): string {
  const { sourceSha, git, show } = input;
  const warn = input.warn ?? console.warn;
  const failed = (error: unknown) =>
    warn("Release notes fall back after a git failure: " + (error as Error).message);
  if (input.kind === "stable") {
    let late: Fragment[] = [];
    try {
      late = fragmentsAt({ rev: sourceSha, git, show, warn });
    } catch (error) {
      failed(error);
    }
    return stableReleaseNotes(show(sourceSha, "CHANGELOG.md") ?? "", input.version, late);
  }
  try {
    const previousTag = previousReleaseTag(input.releases, "v" + input.version, (name) =>
      isAncestorTag(name, sourceSha, git),
    );
    return betaReleaseNotes({
      previousTag,
      ...collectBetaChanges({ sourceSha, previousTag, git, show, warn }),
      sourceSha,
      runUrl: input.runUrl,
    });
  } catch (error) {
    failed(error);
    return provenance(sourceSha, input.runUrl);
  }
}
