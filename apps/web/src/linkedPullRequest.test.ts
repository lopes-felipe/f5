import { expect, it } from "vitest";
import { githubThreadLink } from "./linkedPullRequest";
it("retains the Enterprise host and searchable repository, number and title", () => {
  expect(
    githubThreadLink("https://git.example.com/owner/repo/pull/42", "  Fix rendering  "),
  ).toEqual({
    provider: "github",
    host: "git.example.com",
    repository: "owner/repo",
    number: 42,
    title: "Fix rendering",
    url: "https://git.example.com/owner/repo/pull/42",
  });
});
it.each([
  "http://github.com/a/b/pull/1",
  "https://token@github.com/a/b/pull/1",
  "https://github.com/a/b/issues/1",
  "https://github.com/a/b/pull/9007199254740993",
  "invalid",
])("rejects unsupported PR references: %s", (url) => {
  expect(githubThreadLink(url, "")).toBeNull();
});
