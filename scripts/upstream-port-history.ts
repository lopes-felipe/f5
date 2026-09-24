import { SHA_PATTERN, type FrozenCommit } from "./upstream-port-ledger.ts";

export const AUTHORITATIVE_REPOSITORY = "https://github.com/pingdotgg/t3code.git";
export const UPSTREAM_MAIN_REF = "refs/remotes/upstream/main";
export type RunGit = (args: ReadonlyArray<string>) => string;

export function verifyUpstream(git: RunGit): void {
  const normalize = (url: string) =>
    url
      .trim()
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git\/?$/, "")
      .replace(/\/$/, "");
  const actual = git(["remote", "get-url", "upstream"]);
  if (normalize(actual) !== normalize(AUTHORITATIVE_REPOSITORY))
    throw new Error(`upstream fetch URL is not authoritative: ${actual}`);
}

export function selectRefreshHead(git: RunGit, pin?: string): string {
  if (pin !== undefined && !SHA_PATTERN.test(pin))
    throw new Error("--head requires a full 40-character SHA");
  verifyUpstream(git);
  git(["fetch", "--no-prune", "--no-tags", "upstream", `refs/heads/main:${UPSTREAM_MAIN_REF}`]);
  // Resolve the remote exactly once, then anchor every read to that immutable SHA.
  const fetchedHead = git(["rev-parse", UPSTREAM_MAIN_REF]);
  const ancestry = git(["rev-list", "--first-parent", fetchedHead]).split("\n");
  const head = pin ?? fetchedHead;
  if (!ancestry.includes(head))
    throw new Error(`pinned SHA ${head} is not on upstream/main first-parent ancestry`);
  return head;
}

/** Resolve an append-only delta using immutable SHAs, never a moving ref. */
export function newCommitsSince(git: RunGit, trackedHead: string, head: string): FrozenCommit[] {
  if (head === trackedHead) return [];
  const ancestry = git(["rev-list", "--first-parent", head]).split("\n");
  if (!ancestry.includes(trackedHead)) {
    if (git(["rev-list", "--first-parent", trackedHead]).split("\n").includes(head)) return [];
    throw new Error("selected head diverges from tracked upstream history");
  }
  return git(["log", "--first-parent", "--format=%H%x09%s", `${trackedHead}..${head}`])
    .split("\n")
    .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
}
