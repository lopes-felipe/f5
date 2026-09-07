import { expect, it } from "vitest";
import { isCapturedPrTarget } from "./githubPrTarget";
it("requires a captured host for URL and relative PR commands", () => {
  expect(
    isCapturedPrTarget(["pr", "review", "https://github.com/org/repo/pull/1"], "github.com"),
  ).toBe(true);
  for (const target of [
    "http://github.com/org/repo/pull/1",
    "https://other.test/org/repo/pull/1",
    "1",
    "org/repo#1",
  ])
    expect(isCapturedPrTarget(["pr", "review", target], "github.com")).toBe(false);
  expect(isCapturedPrTarget(["pr", "review", "1", "--repo", "org/repo"], "github.com")).toBe(true);
  expect(
    isCapturedPrTarget(["pr", "review", "1", "--repo", "other.test/org/repo"], "github.com"),
  ).toBe(false);
});

it("accepts the equals and -R spellings gh itself supports", () => {
  for (const args of [
    ["pr", "review", "1", "--repo=org/repo"],
    ["pr", "review", "1", "-R", "org/repo"],
    ["pr", "review", "1", "-R=org/repo"],
    ["pr", "review", "1", "--repo=github.com/org/repo"],
  ])
    expect(isCapturedPrTarget(args, "github.com")).toBe(true);
  for (const args of [
    ["pr", "review", "1", "--repo=other.test/org/repo"],
    ["pr", "review", "1", "-R", "other.test/org/repo"],
    // A trailing flag with no value must not be read as an absent repository.
    ["pr", "review", "1", "--repo"],
  ])
    expect(isCapturedPrTarget(args, "github.com")).toBe(false);
});

it("rejects flag-only pull request commands that never name a target", () => {
  // `gh pr list --head x` resolves against cwd's remote, which the captured
  // credential cannot vouch for, so it must not run under a credential scope.
  expect(isCapturedPrTarget(["pr", "list", "--head", "feature"], "github.com")).toBe(false);
  expect(isCapturedPrTarget(["pr", "create", "--base", "main"], "github.com")).toBe(false);
  expect(
    isCapturedPrTarget(["pr", "list", "--head", "feature", "--repo", "org/repo"], "github.com"),
  ).toBe(true);
  // Non-PR commands are outside this guard entirely.
  expect(isCapturedPrTarget(["api", "user"], "github.com")).toBe(true);
  expect(isCapturedPrTarget(["repo", "view", "org/repo"], "github.com")).toBe(true);
});
