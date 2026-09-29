import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { issueReferenceUrl, remarkIssueReferences } from "./remarkIssueReferences";
import { repositoryLinksForThread } from "../repositoryLinkContext";

describe("repository references", () => {
  it.each([
    ["github", "https://github.com/a/b", "https://github.com/a/b/issues/123"],
    [
      "gitlab",
      "https://gitlab.com/group/sub/repo",
      "https://gitlab.com/group/sub/repo/-/issues/123",
    ],
    ["bitbucket", "https://bitbucket.org/a/b", "https://bitbucket.org/a/b/issues/123"],
    ["forgejo", "https://codeberg.org/a/b", "https://codeberg.org/a/b/issues/123"],
    ["gitea", "https://git.example/a/b", "https://git.example/a/b/issues/123"],
    [
      "azure-devops",
      "https://dev.azure.com/org/project/_git/repo",
      "https://dev.azure.com/org/project/_workitems/edit/123",
    ],
  ])("links %s references", (provider, webUrl, expected) =>
    expect(issueReferenceUrl({ provider, webUrl }, "123")).toBe(expected),
  );
  it("keeps qualified references on the repository's host", () => {
    expect(
      issueReferenceUrl(
        { provider: "github", webUrl: "https://ghe.example/a/b" },
        "42",
        "other/repo",
      ),
    ).toBe("https://ghe.example/other/repo/issues/42");
    expect(
      issueReferenceUrl({ provider: "github", webUrl: "javascript:alert(1)" }, "42"),
    ).toBeNull();
  });
  it("links prose without touching code or existing links", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Fix #123 and other/repo#42." },
            { type: "inlineCode", value: "#123" },
            {
              type: "link",
              url: "https://example.com",
              children: [{ type: "text", value: "#123" }],
            },
          ],
        },
        { type: "code", value: "#123" },
      ],
    };
    remarkIssueReferences({ provider: "github", webUrl: "https://github.com/a/b" })(tree);
    expect(JSON.stringify(tree)).toContain("https://github.com/other/repo/issues/42");
    expect(tree.children[1]).toEqual({ type: "code", value: "#123" });
    const paragraph = tree.children[0];
    if (paragraph?.type !== "paragraph") throw new Error("missing paragraph");
    expect(paragraph.children.filter((node) => node.type === "link")).toHaveLength(3);
    expect(paragraph.children.at(-1)).toEqual({
      type: "link",
      url: "https://example.com",
      children: [{ type: "text", value: "#123" }],
    });
  });
  it("uses the PR target before the project remote", () => {
    expect(
      repositoryLinksForThread(
        { provider: "gitlab", url: "https://gitlab.com/base/repo/-/merge_requests/1" },
        { kind: "gitlab", webUrl: "https://gitlab.com/fork/repo" },
      ),
    ).toEqual({ provider: "gitlab", webUrl: "https://gitlab.com/base/repo" });
  });
});

it("does not invent issue routes for unsupported forges", () => {
  expect(
    issueReferenceUrl({ provider: "unknown", webUrl: "https://git.example/a/b" }, "2"),
  ).toBeNull();
});
