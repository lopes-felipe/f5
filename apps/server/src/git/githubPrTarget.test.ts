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
