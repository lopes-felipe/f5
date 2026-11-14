// Fails a pull request that changes shipped code without adding a changelog entry: a fragment
// under changes/ or, for PRs opened before fragments, a CHANGELOG.md Unreleased bullet.
// Labels and files come from the API, so label changes apply without a new push.
import { pathToFileURL } from "node:url";
import {
  FRAGMENTS_DIR,
  FRAGMENTS_README,
  isFragmentDirPath,
  newUnreleasedBullets,
  parseFragmentPath,
  validateFragment,
} from "./lib/changelog-fragments.ts";
import { runGh, type Gh } from "./lib/github-cli.ts";

export const SKIP_LABEL = "no-changelog";
const CHANGELOG = "CHANGELOG.md";

// Automation branches, trusted only from this repository and, where a bot opens them, that bot.
const EXEMPT_BRANCHES: readonly { prefix: string; author?: string }[] = [
  { prefix: "dependabot/", author: "dependabot[bot]" },
  { prefix: "release/prepare-", author: "f5-release-automation-lopes-felipe[bot]" },
  { prefix: "f5/upstream-ledger-" },
];

export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status?: string;
}

export interface PullRequestFacts {
  headRef: string;
  author: string;
  sameRepository: boolean;
  labels: readonly string[];
  files: readonly PullRequestFile[];
  /** CHANGELOG.md at the base and head commits, read only when the PR touches it. */
  changelog?: { before: string; after: string };
  /** Head contents of every file under changes/ that the PR adds or modifies. */
  fragments?: readonly FragmentFile[];
}

export interface FragmentFile {
  path: string;
  /** The files API status: "added", "modified", "renamed", ... */
  status: string;
  content: string;
}

export type ChangelogVerdict =
  | { ok: true; reason: string; warning?: string }
  | { ok: false; reason: string };

/** Paths that never ship to users, so they need no changelog entry. */
export function exemptPath(path: string): boolean {
  if (path === CHANGELOG) return false;
  return (
    /^(docs|\.github|upstream|apps\/server\/integration)\//.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    path.endsWith(".browser.tsx") ||
    path.endsWith(".md")
  );
}

/**
 * Whether the head adds an Unreleased bullet that the base had nowhere, so edits to released
 * entries, reordering, and moving an old bullet up do not count as a new entry.
 */
export function addsUnreleasedEntry(before: string, after: string): boolean {
  return newUnreleasedBullets(before, after).length > 0;
}

/** Problems with the fragments a PR adds or edits; release preparation would reject them. */
export function fragmentProblems(fragments: readonly FragmentFile[]): string[] {
  const problems: string[] = [];
  for (const fragment of fragments) {
    try {
      if (parseFragmentPath(fragment.path) !== null)
        validateFragment(fragment.path, fragment.content);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
}

export function checkChangelog(facts: PullRequestFacts): ChangelogVerdict {
  // Checked before the label: a malformed fragment would break the next release preparation.
  const problems = fragmentProblems(facts.fragments ?? []);
  if (problems.length > 0) {
    return {
      ok: false,
      reason: `Fix the changelog fragments (see ${FRAGMENTS_README}): ${problems.join("; ")}`,
    };
  }
  if (facts.labels.includes(SKIP_LABEL)) {
    return { ok: true, reason: `The "${SKIP_LABEL}" label is set.` };
  }
  const branch = EXEMPT_BRANCHES.find(({ prefix }) => facts.headRef.startsWith(prefix));
  if (branch && facts.sameRepository && (!branch.author || branch.author === facts.author)) {
    return { ok: true, reason: `Automation branches starting with ${branch.prefix} are exempt.` };
  }
  const added = (facts.fragments ?? []).filter(
    (fragment) => fragment.status === "added" && parseFragmentPath(fragment.path) !== null,
  );
  if (added.length > 0) {
    return { ok: true, reason: `Adds changelog fragment ${added.map((f) => f.path).join(", ")}.` };
  }
  if (facts.changelog && addsUnreleasedEntry(facts.changelog.before, facts.changelog.after)) {
    return {
      ok: true,
      reason: "CHANGELOG.md adds an entry under ## [Unreleased].",
      warning:
        `Entries in CHANGELOG.md conflict with every other open PR. Move it to ` +
        `${FRAGMENTS_DIR}/<category>/<slug>.md instead (see ${FRAGMENTS_README}).`,
    };
  }
  // The files API stops at 3000 entries, so a full page cannot prove every file is exempt.
  const shipped = facts.files.flatMap((file) =>
    [file.filename, file.previous_filename].filter(
      (path): path is string => path !== undefined && !exemptPath(path),
    ),
  );
  if (
    facts.files.length > 0 &&
    facts.files.length < 3000 &&
    shipped.every((path) => path === CHANGELOG)
  ) {
    return { ok: true, reason: "Only the changelog, docs, tests, and workflow files changed." };
  }
  return {
    ok: false,
    reason:
      `Add a changelog fragment, ${FRAGMENTS_DIR}/<category>/<slug>.md with a "- " bullet ` +
      `describing the user-visible change (see ${FRAGMENTS_README}), ` +
      `or add the "${SKIP_LABEL}" label if users will not notice it.`,
  };
}

async function readFileAt(
  repository: string,
  sha: string,
  gh: Gh,
  path: string = CHANGELOG,
): Promise<string> {
  try {
    return await gh([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      "repos/" +
        repository +
        "/contents/" +
        path.split("/").map(encodeURIComponent).join("/") +
        "?ref=" +
        sha,
    ]);
  } catch (error) {
    if (/\b404\b|Not Found/.test(String(error))) return "";
    throw error;
  }
}

export async function readPullRequestFacts(
  repository: string,
  number: number,
  gh: Gh = runGh,
): Promise<PullRequestFacts> {
  const root = "repos/" + repository + "/pulls/" + number;
  const pull = JSON.parse(await gh(["api", root])) as {
    user: { login: string };
    head: { ref: string; sha: string; repo: { full_name: string } | null };
    base: { sha: string; repo: { full_name: string } };
    labels: { name: string }[];
  };
  const pages = JSON.parse(
    await gh(["api", "--paginate", "--slurp", root + "/files?per_page=100"]),
  ) as PullRequestFile[][];
  const files = pages.flat();
  const touchesChangelog = files.some(
    (file) => file.filename === CHANGELOG || file.previous_filename === CHANGELOG,
  );
  const fragmentFiles = files.filter(
    (file) => isFragmentDirPath(file.filename) && file.status !== "removed",
  );
  const fragments = await Promise.all(
    fragmentFiles.map(async (file) => ({
      path: file.filename,
      status: file.status ?? "",
      content: await readFileAt(repository, pull.head.sha, gh, file.filename),
    })),
  );
  return {
    headRef: pull.head.ref,
    author: pull.user.login,
    sameRepository: pull.head.repo?.full_name === pull.base.repo.full_name,
    labels: pull.labels.map((label) => label.name),
    files,
    ...(fragments.length > 0 ? { fragments } : {}),
    ...(touchesChangelog
      ? {
          changelog: {
            before: await readFileAt(repository, pull.base.sha, gh),
            after: await readFileAt(repository, pull.head.sha, gh),
          },
        }
      : {}),
  };
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const number = Number(process.env.PR_NUMBER);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isInteger(number) || number <= 0) {
    throw new Error("GITHUB_REPOSITORY and PR_NUMBER must identify a pull request");
  }
  const verdict = checkChangelog(await readPullRequestFacts(repository, number));
  if (verdict.ok) {
    if (verdict.warning)
      console.log("::warning title=Use a changelog fragment::" + verdict.warning);
    console.log(verdict.reason);
    return;
  }
  console.log("::error title=Changelog entry missing::" + verdict.reason);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
