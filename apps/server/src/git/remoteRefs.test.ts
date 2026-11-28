import { describe, expect, it } from "vitest";

import {
  extractBranchNameFromRemoteRef,
  isPullRequestTrackingAlias,
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "./remoteRefs.ts";

describe("parseRemoteNamesInGitOrder", () => {
  it("preserves git remote output order", () => {
    expect(parseRemoteNamesInGitOrder("origin\nfork-seed\n")).toEqual(["origin", "fork-seed"]);
  });
});

describe("parseRemoteNames", () => {
  it("sorts remote names by descending length for prefix-safe parsing", () => {
    expect(parseRemoteNames("origin\norigin-fork\nteam\n")).toEqual([
      "origin-fork",
      "origin",
      "team",
    ]);
  });
});

describe("parseRemoteRefWithRemoteNames", () => {
  it("matches the longest remote name when prefixes overlap", () => {
    expect(
      parseRemoteRefWithRemoteNames("origin-fork/feature/demo", ["origin", "origin-fork"]),
    ).toEqual({
      remoteRef: "origin-fork/feature/demo",
      remoteName: "origin-fork",
      branchName: "feature/demo",
    });
  });
});

describe("extractBranchNameFromRemoteRef", () => {
  it("extracts branch names from refs/remotes paths using the remote name", () => {
    expect(
      extractBranchNameFromRemoteRef("refs/remotes/fork-seed/feature/demo", {
        remoteName: "fork-seed",
      }),
    ).toBe("feature/demo");
  });
});

describe("isPullRequestTrackingAlias", () => {
  it.each([
    ["t3code/pr-91/main", "main"],
    ["f5/pr-91/main", "main"],
    ["team/me/pr-7/feature/x", "feature/x"],
  ])("treats %s as an alias of %s", (local, upstream) => {
    expect(isPullRequestTrackingAlias(local, upstream)).toBe(true);
  });

  it.each([
    ["pr-91/main", "main"],
    ["f5/pr-91/main", "other"],
    ["f5/pr-0/main", "main"],
    ["f5/wip/main", "main"],
  ])("does not treat %s as an alias of %s", (local, upstream) => {
    expect(isPullRequestTrackingAlias(local, upstream)).toBe(false);
  });
});
