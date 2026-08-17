import { describe, expect, it } from "vitest";

import {
  discoverSourceControlProviderIdentities,
  selectPrimarySourceControlProviderIdentity,
} from "./discovery.ts";

describe("source-control discovery", () => {
  it("discovers all remotes and prefers a recognized origin", () => {
    const identities = discoverSourceControlProviderIdentities([
      { name: "fork", url: "git@gitlab.com:octo/fork.git" },
      { name: "origin", url: "https://github.com/octo/repo.git" },
    ]);

    expect(identities).toHaveLength(2);
    expect(selectPrimarySourceControlProviderIdentity(identities)).toMatchObject({
      kind: "github",
      remoteName: "origin",
      host: "github.com",
      owner: "octo",
      repository: "repo",
    });
  });

  it("falls back to a recognized non-origin remote", () => {
    const identities = discoverSourceControlProviderIdentities([
      { name: "origin", url: "ssh://internal/repo" },
      { name: "upstream", url: "git@bitbucket.org:octo/repo.git" },
    ]);

    expect(selectPrimarySourceControlProviderIdentity(identities)).toMatchObject({
      kind: "bitbucket",
      remoteName: "upstream",
    });
  });

  it("keeps an unknown origin fallback ahead of an unavailable provider", () => {
    const identities = discoverSourceControlProviderIdentities([
      { name: "origin", url: "/Users/me/local-mirror.git" },
      { name: "backup", url: "git@gitlab.com:octo/repo.git" },
    ]);

    expect(
      selectPrimarySourceControlProviderIdentity(identities, {
        availableProviderKinds: ["github"],
      }),
    ).toMatchObject({
      kind: "unknown",
      remoteName: "origin",
    });
  });

  it("keeps every remote identity so origin preference is not lost to a duplicate URL", () => {
    const identities = discoverSourceControlProviderIdentities([
      { name: "backup", url: "https://github.com/octo/repo.git" },
      { name: "origin", url: "https://github.com/octo/repo.git" },
    ]);

    expect(identities).toHaveLength(2);
    expect(selectPrimarySourceControlProviderIdentity(identities).remoteName).toBe("origin");
  });

  it("recognizes a configured GitHub Enterprise host", () => {
    const identities = discoverSourceControlProviderIdentities(
      [{ name: "origin", url: "git@github.corp.example:octo/repo.git" }],
      { githubHosts: ["github.corp.example"] },
    );

    expect(identities[0]).toMatchObject({
      kind: "github",
      host: "github.corp.example",
      owner: "octo",
      repository: "repo",
    });
  });
});
