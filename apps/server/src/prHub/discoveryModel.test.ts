import { describe, expect, it } from "vitest";
import { normalizeGraphqlPr } from "./discoveryModel";

describe("repository merge methods", () => {
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
