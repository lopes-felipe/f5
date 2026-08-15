import { describe, expect, it } from "vitest";

import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
  parseSourceControlRemoteUrl,
  resolveChangeRequestWebUrl,
  sourceControlPullRequestKeysEqual,
} from "./sourceControl";

describe("source-control pull-request keys", () => {
  it("formats provider-qualified keys and parses legacy GitHub keys", () => {
    expect(
      formatSourceControlPullRequestKey({
        provider: "gitlab",
        host: "gitlab.example.com",
        repository: "platform/f5",
        number: 42,
      }),
    ).toBe("gitlab:gitlab.example.com/platform/f5#42");
    expect(parseSourceControlPullRequestKey("github.com/octo/f5#7")).toEqual({
      provider: "github",
      host: "github.com",
      repository: "octo/f5",
      number: 7,
    });
  });

  it("matches legacy links to provider-qualified GitHub keys", () => {
    expect(
      sourceControlPullRequestKeysEqual("github.com/octo/f5#7", "github:github.com/Octo/F5#7"),
    ).toBe(true);
    expect(
      sourceControlPullRequestKeysEqual("github.com/octo/f5#7", "gitlab:github.com/octo/f5#7"),
    ).toBe(false);
  });

  it("rejects malformed and non-positive pull-request numbers", () => {
    expect(parseSourceControlPullRequestKey("github:github.com/octo/f5#0")).toBeNull();
    expect(parseSourceControlPullRequestKey("github:github.com/octo/f5#nope")).toBeNull();
  });
});

describe("parseSourceControlRemoteUrl", () => {
  it("parses GitHub SSH remotes", () => {
    expect(parseSourceControlRemoteUrl("git@github.com:pingdotgg/t3code.git")).toEqual({
      kind: "github",
      host: "github.com",
      owner: "pingdotgg",
      repository: "t3code",
      webUrl: "https://github.com/pingdotgg/t3code",
    });
  });

  it("preserves nested GitLab namespaces", () => {
    expect(
      parseSourceControlRemoteUrl("https://gitlab.example.com/platform/agents/f5.git"),
    ).toEqual({
      kind: "gitlab",
      host: "gitlab.example.com",
      owner: "platform/agents",
      repository: "f5",
      webUrl: "https://gitlab.example.com/platform/agents/f5",
    });
  });

  it("does not classify unrelated hosts containing provider substrings", () => {
    expect(parseSourceControlRemoteUrl("https://evilgitlab.com/platform/f5.git")).toMatchObject({
      kind: "unknown",
      host: "evilgitlab.com",
    });
    expect(
      parseSourceControlRemoteUrl("https://notdev.azure.com/org/project/_git/f5"),
    ).toMatchObject({
      kind: "unknown",
      host: "notdev.azure.com",
    });
  });

  it("parses Bitbucket remotes", () => {
    expect(parseSourceControlRemoteUrl("git@bitbucket.org:wolt/f5.git")).toEqual({
      kind: "bitbucket",
      host: "bitbucket.org",
      owner: "wolt",
      repository: "f5",
      webUrl: "https://bitbucket.org/wolt/f5",
    });
  });

  it("parses Azure DevOps HTTPS remotes", () => {
    expect(parseSourceControlRemoteUrl("https://dev.azure.com/org/project/_git/f5")).toEqual({
      kind: "azure-devops",
      host: "dev.azure.com",
      owner: "org/project",
      repository: "f5",
      webUrl: "https://dev.azure.com/org/project/_git/f5",
    });
  });

  it("parses Azure DevOps SSH remotes into browser URLs", () => {
    expect(parseSourceControlRemoteUrl("ssh://git@ssh.dev.azure.com/v3/org/project/f5")).toEqual({
      kind: "azure-devops",
      host: "ssh.dev.azure.com",
      owner: "org/project",
      repository: "f5",
      webUrl: "https://dev.azure.com/org/project/_git/f5",
    });
  });

  it("returns unknown metadata for unsupported remote strings", () => {
    expect(parseSourceControlRemoteUrl("not a remote")).toEqual({
      kind: "unknown",
      host: null,
      owner: null,
      repository: null,
      webUrl: null,
    });
  });
});

describe("resolveChangeRequestWebUrl", () => {
  const base = {
    id: "42",
    displayNumber: "42",
    provider: {
      kind: "gitlab" as const,
      webUrl: "https://gitlab.example.com/platform/f5",
    },
  };

  it("prefers the provider-supplied change request URL", () => {
    expect(
      resolveChangeRequestWebUrl({ ...base, url: "https://reviews.example.test/change/42" }),
    ).toBe("https://reviews.example.test/change/42");
  });

  it("builds a provider-specific fallback and rejects unsafe schemes", () => {
    expect(resolveChangeRequestWebUrl({ ...base, url: "" })).toBe(
      "https://gitlab.example.com/platform/f5/-/merge_requests/42",
    );
    expect(
      resolveChangeRequestWebUrl({
        ...base,
        url: "javascript:alert(1)",
        provider: { ...base.provider, webUrl: "file:///tmp/f5" },
      }),
    ).toBeNull();
  });
});
