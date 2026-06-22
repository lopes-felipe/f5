import { describe, expect, it } from "vitest";

import { parseSourceControlRemoteUrl } from "./sourceControl";

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
