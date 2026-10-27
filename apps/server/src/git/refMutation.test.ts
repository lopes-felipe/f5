import { expect, it } from "vitest";
import { gitMutatesRefSnapshot } from "./refMutation.ts";

it.each([
  [["diff", "--", "branch"], false],
  [["-c", "alias.name=checkout", "status"], false],
  [["-c", "core.hooksPath=/tmp", "merge", "--ff-only", "origin/main"], true],
  [["--no-optional-locks", "branch", "--list", "feature"], false],
  [["branch", "feature"], true],
  [["worktree", "list", "--porcelain"], false],
  [["worktree", "add", "/tmp/tree"], true],
  [["remote", "get-url", "origin"], false],
  [["remote", "add", "origin", "url"], true],
  [["tag", "--list"], false],
  [["tag", "v1"], true],
  [["symbolic-ref", "--quiet", "HEAD"], false],
  [["symbolic-ref", "HEAD", "refs/heads/feature"], true],
  ...["merge", "rebase", "cherry-pick", "revert"].map((command) => [[command, "feature"], true]),
] as const)("classifies %j as mutation=%s", (args, expected) => {
  expect(gitMutatesRefSnapshot(args as readonly string[])).toBe(expected);
});
