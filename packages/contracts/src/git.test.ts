import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
      expectedHeadOid: "abc123",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
    expect(parsed.expectedHeadOid).toBe("abc123");
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      changeRequest: {
        provider: {
          kind: "github",
          remoteName: "origin",
          host: "github.com",
          owner: "pingdotgg",
          repository: "codething-mvp",
          webUrl: "https://github.com/pingdotgg/codething-mvp",
        },
        id: "42",
        displayNumber: "42",
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        updatedAt: null,
        isCrossRepository: false,
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
    expect(parsed.changeRequest?.provider.kind).toBe("github");
    expect(parsed.changeRequest?.headRefName).toBe("feature/pr-threads");
  });

  it("accepts empty display titles on change requests", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      changeRequest: {
        provider: {
          kind: "github",
          remoteName: "origin",
          host: "github.com",
          owner: "pingdotgg",
          repository: "codething-mvp",
          webUrl: "https://github.com/pingdotgg/codething-mvp",
        },
        id: "42",
        displayNumber: "42",
        title: "",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        updatedAt: null,
        isCrossRepository: false,
      },
    });

    expect(parsed.changeRequest?.title).toBe("");
  });
});
