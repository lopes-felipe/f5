import { describe, expect, it } from "vitest";

import {
  extractBranchNameFromRemoteRef,
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
