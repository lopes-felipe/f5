import { describe, expect, it } from "vitest";
import { normalizeGraphqlPr, buildTrackedPullRequest } from "./discoveryModel";

describe("repository merge methods", () => {
  it.each([
    [true, "BLOCKED", true],
    [false, "BLOCKED", false],
    [true, "CLEAN", false],
    [true, "HAS_HOOKS", false],
    [true, "UNSTABLE", false],
  ])(
    "advertises auto-merge only when it waits (%s, %s)",
    (autoMergeAllowed, mergeStateStatus, expected) => {
      const pr = normalizeGraphqlPr({
        host: "github.com",
        viewerLogin: "me",
        viewerTeams: new Set(),
        aliases: new Set(["author"]),
        node: {
          number: 1,
          title: "Test",
          url: "https://github.com/acme/repo/pull/1",
          state: "OPEN",
          mergeStateStatus,
          repository: { nameWithOwner: "acme/repo", viewerPermission: "WRITE", autoMergeAllowed },
        },
      })!;
      expect(
        buildTrackedPullRequest(pr, "me", undefined).forgeCapabilities?.actions.includes(
          "enable-auto-merge",
        ),
      ).toBe(expected);
    },
  );
  it.each([
    [
      { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true },
      ["squash", "rebase"],
    ],
    [{ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: false }, ["merge"]],
    [{}, []],
  ])("advertises only explicitly allowed methods", (methods, expected) => {
    const pr = normalizeGraphqlPr({
      host: "github.com",
      viewerLogin: "me",
      viewerTeams: new Set(),
      aliases: new Set(),
      node: {
        number: 1,
        title: "Test",
        url: "https://github.com/acme/repo/pull/1",
        repository: { nameWithOwner: "acme/repo", ...methods },
      },
    });
    expect(pr?.allowedMergeMethods).toEqual(expected);
  });
});
