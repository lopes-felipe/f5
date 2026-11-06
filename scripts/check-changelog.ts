// Fails a pull request that changes shipped code without adding a CHANGELOG.md entry.
// Labels and files come from the API, so label changes apply without a new push.
import { pathToFileURL } from "node:url";
import { runGh, type Gh } from "./lib/github-cli.ts";

export const SKIP_LABEL = "no-changelog";
const EXEMPT_BRANCH_PREFIXES = ["dependabot/", "release/prepare-", "f5/upstream-ledger-"];

export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  patch?: string;
}

export interface PullRequestFacts {
  headRef: string;
  labels: readonly string[];
  files: readonly PullRequestFile[];
}

export type ChangelogVerdict = { ok: true; reason: string } | { ok: false; reason: string };

/** Paths that never ship to users, so they need no changelog entry. */
export function exemptPath(path: string): boolean {
  if (path === "CHANGELOG.md") return false;
  return (
    /^(docs|\.github|upstream)\//.test(path) ||
    /\.test\.tsx?$/.test(path) ||
    path.endsWith(".browser.tsx") ||
    path.endsWith(".md")
  );
}

/** An added top-level bullet, so a whitespace or heading edit does not count. */
export function addsChangelogEntry(patch: string): boolean {
  return patch.split("\n").some((line) => line.startsWith("+- ") && line.trim().length > 3);
}

export function checkChangelog(facts: PullRequestFacts): ChangelogVerdict {
  if (facts.labels.includes(SKIP_LABEL)) {
    return { ok: true, reason: `The "${SKIP_LABEL}" label is set.` };
  }
  const prefix = EXEMPT_BRANCH_PREFIXES.find((candidate) => facts.headRef.startsWith(candidate));
  if (prefix) return { ok: true, reason: `Branches starting with ${prefix} are exempt.` };
  const changelog = facts.files.find((file) => file.filename === "CHANGELOG.md");
  if (changelog) {
    // GitHub omits patches for very large diffs; the file changed, so trust it.
    if (changelog.patch === undefined && changelog.status !== "removed") {
      return { ok: true, reason: "CHANGELOG.md changed (its diff is too large to inspect)." };
    }
    if (changelog.patch !== undefined && addsChangelogEntry(changelog.patch)) {
      return { ok: true, reason: "CHANGELOG.md adds an entry." };
    }
  }
  // The files API stops at 3000 entries, so a full page cannot prove every file is exempt.
  const complete = facts.files.length < 3000;
  if (
    complete &&
    facts.files.length > 0 &&
    facts.files.every(
      (file) =>
        exemptPath(file.filename) &&
        (file.previous_filename === undefined || exemptPath(file.previous_filename)),
    )
  ) {
    return { ok: true, reason: "Only docs, tests, and workflow files changed." };
  }
  return {
    ok: false,
    reason:
      "Add a bullet under ## [Unreleased] in CHANGELOG.md describing the user-visible change, " +
      `or add the "${SKIP_LABEL}" label if users will not notice it.`,
  };
}

export async function readPullRequestFacts(
  repository: string,
  number: number,
  gh: Gh = runGh,
): Promise<PullRequestFacts> {
  const root = "repos/" + repository + "/pulls/" + number;
  const pull = JSON.parse(await gh(["api", root])) as {
    head: { ref: string };
    labels: { name: string }[];
  };
  const pages = JSON.parse(
    await gh(["api", "--paginate", "--slurp", root + "/files?per_page=100"]),
  ) as PullRequestFile[][];
  return {
    headRef: pull.head.ref,
    labels: pull.labels.map((label) => label.name),
    files: pages.flat(),
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
    console.log(verdict.reason);
    return;
  }
  console.log("::error title=Changelog entry missing::" + verdict.reason);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
