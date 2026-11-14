// Beta release notes: the changelog entries added since the previous published release.
// The desktop updater shows every intermediate release's notes in a row, so per-beta changes
// stack up there without repeating entries.
import { compareCliReleaseVersions } from "@t3tools/shared/cliRelease";
import {
  ADD_TIMES_ARGS,
  FRAGMENTS_DIR,
  addFragments,
  emptyGroups,
  isFragmentDirPath,
  newEntries,
  orderFragments,
  parseAddTimes,
  parseFragmentPath,
  renderSection,
  unreleasedGroups,
  validateFragment,
  type Fragment,
  type SectionGroups,
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

export interface BetaChanges {
  /** Unreleased CHANGELOG.md entries the previous release did not have. */
  legacy: SectionGroups;
  fragments: Fragment[];
}

/** Collects the changelog entries added between `previousTag` (or the beginning) and the source. */
export function collectBetaChanges(input: {
  sourceSha: string;
  previousTag: string | undefined;
  git: (args: readonly string[]) => string;
  show: (rev: string, path: string) => string | undefined;
  warn?: (message: string) => void;
}): BetaChanges {
  const { sourceSha, previousTag, git, show } = input;
  const warn = input.warn ?? console.warn;
  const base = previousTag === undefined ? undefined : "refs/tags/" + previousTag;
  const dir = FRAGMENTS_DIR + "/";
  const listed = base
    ? git(["diff", "--no-renames", "--diff-filter=A", "--name-only", base, sourceSha, "--", dir])
    : git(["ls-tree", "-r", "--name-only", sourceSha, "--", dir]);
  const fragments: Fragment[] = [];
  for (const path of listed.split("\n").map((line) => line.trim())) {
    if (!isFragmentDirPath(path)) continue;
    // The Changelog check rejects malformed fragments; never block a beta over one.
    try {
      const parsed = parseFragmentPath(path);
      if (parsed === null) continue;
      const entries = validateFragment(path, show(sourceSha, path) ?? "");
      fragments.push({ path, category: parsed.category, entries });
    } catch (error) {
      warn("Skipping changelog fragment: " + (error as Error).message);
    }
  }
  const range = base ? base + ".." + sourceSha : sourceSha;
  const times = parseAddTimes(git([...ADD_TIMES_ARGS, range, "--", dir]));
  const before = base ? (show(base, "CHANGELOG.md") ?? "") : "";
  const after = show(sourceSha, "CHANGELOG.md");
  return {
    legacy: after === undefined ? emptyGroups() : newEntries(unreleasedGroups(after), before),
    fragments: orderFragments(fragments, times),
  };
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
    [
      intro,
      section,
      "Automated beta from " + input.sourceSha + ".",
      "Source and validation: " + input.runUrl,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
