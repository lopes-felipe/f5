import { SHA_PATTERN } from "./upstream-port-ledger.ts";

export const AUTHORITATIVE_REPOSITORY = "https://github.com/pingdotgg/t3code.git";
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
  git(["fetch", "--no-prune", "--no-tags", "upstream", "main"]);
  // Resolve the remote exactly once, then anchor every read to that immutable SHA.
  const fetchedHead = git(["rev-parse", "upstream/main"]);
  const ancestry = git(["rev-list", "--first-parent", fetchedHead]).split("\n");
  const head = pin ?? fetchedHead;
  if (!ancestry.includes(head))
    throw new Error(`pinned SHA ${head} is not on upstream/main first-parent ancestry`);
  return head;
}
