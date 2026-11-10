import { parseGitHubPullRequestUrl } from "./sourceControl";
import { describe, expect, it } from "vitest";

import {
  detectCreatedPullRequest,
  formatSourceControlPullRequestKey,
  hasThreadPullRequestLink,
  parseSourceControlPullRequestKey,
  parseSourceControlRemoteUrl,
  isSshRemoteUrl,
  resolveChangeRequestWebUrl,
  sourceControlPullRequestKeysEqual,
  toThreadPullRequestLink,
  updateThreadPullRequestLinks,
} from "./sourceControl";

it.each(["github.com", "gitlab.com", "bitbucket.org", "code.example.test"])(
  "resolves userless SSH remotes on %s",
  (host) => {
    const remote = host + ":team/project.git";
    expect(isSshRemoteUrl(remote)).toBe(true);
    expect(parseSourceControlRemoteUrl(remote)).toMatchObject({
      host,
      owner: "team",
      repository: "project",
      webUrl: "https://" + host + "/team/project",
    });
  },
);

it.each([
  "C:/repos/project",
  "C:\\repos\\project",
  "./team:group/repo",
  "hg::team/repo",
  "file:///srv/git/repo",
])("does not treat %s as SSH", (remote) => expect(isSshRemoteUrl(remote)).toBe(false));

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

  it("classifies SSH URLs independently of an explicit port", () => {
    expect(parseSourceControlRemoteUrl("ssh://git@github.com:22/pingdotgg/t3code.git")).toEqual({
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

  it("classifies GitHub Enterprise Cloud data residency hosts on ghe.com as GitHub", () => {
    expect(parseSourceControlRemoteUrl("https://acme.ghe.com/owner/repo.git")).toEqual({
      kind: "github",
      host: "acme.ghe.com",
      owner: "owner",
      repository: "repo",
      webUrl: "https://acme.ghe.com/owner/repo",
    });
    expect(parseSourceControlRemoteUrl("git@acme.ghe.com:owner/repo.git").kind).toBe("github");
    expect(parseSourceControlRemoteUrl("https://ghe.com/owner/repo.git").kind).toBe("unknown");
    expect(parseSourceControlRemoteUrl("https://acme.notghe.com/owner/repo.git").kind).toBe(
      "unknown",
    );
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

it("restricts manually tracked PR URLs to the selected host", () => {
  expect(parseGitHubPullRequestUrl("https://github.com/org/repo/pull/42/files#diff")).toEqual({
    provider: "github",
    host: "github.com",
    repository: "org/repo",
    number: 42,
  });
  for (const url of [
    "http://github.com/org/repo/pull/42",
    "https://github.com.evil/org/repo/pull/42",
    "https://secret@github.com/org/repo/pull/42",
    "https://github.com/org/repo/pull/0",
    "https://github.com/org/repo/pull/9007199254740992",
  ])
    expect(parseGitHubPullRequestUrl(url)).toBeNull();
  expect(
    parseGitHubPullRequestUrl("https://enterprise.example/org/repo/pull/1", "enterprise.example")
      ?.number,
  ).toBe(1);
});

describe("SSH usernames", () => {
  it.each(["deploy", "gitlab", "build.bot", "ci-user"])("parses an SCP remote for %s", (user) => {
    expect(parseSourceControlRemoteUrl(`${user}@github.com:owner/repo.git`)).toMatchObject({
      kind: "github",
      host: "github.com",
      owner: "owner",
      repository: "repo",
    });
  });
});

import { parseSourceControlPullRequestUrl } from "./sourceControl";
it("parses provider-qualified URLs including nested namespaces and self-hosted Forgejo", () => {
  expect(
    parseSourceControlPullRequestUrl("https://gitlab.com/team/nested/repo/-/merge_requests/7"),
  ).toEqual({ provider: "gitlab", host: "gitlab.com", repository: "team/nested/repo", number: 7 });
  expect(
    parseSourceControlPullRequestUrl("https://dev.azure.com/org/project/_git/repo/pullrequest/8"),
  ).toEqual({
    provider: "azure-devops",
    host: "dev.azure.com",
    repository: "org/project/repo",
    number: 8,
  });
  expect(parseSourceControlPullRequestUrl("https://codeberg.org/team/repo/pulls/9")).toEqual({
    provider: "forgejo",
    host: "codeberg.org",
    repository: "team/repo",
    number: 9,
  });
  expect(
    parseSourceControlPullRequestUrl(
      "https://forge.example/team/repo/pulls/4",
      "forgejo",
      "forge.example",
    )?.number,
  ).toBe(4);
  expect(
    parseSourceControlPullRequestUrl(
      "https://attacker.example/team/repo/pull/4",
      "forgejo",
      "forge.example",
    ),
  ).toBeNull();
  expect(
    parseSourceControlPullRequestUrl(
      "https://forge.example/team/repo/pull/0",
      "forgejo",
      "forge.example",
    ),
  ).toBeNull();
  expect(
    parseSourceControlPullRequestUrl(
      "https://user:password@forge.example/team/repo/pull/4",
      "forgejo",
      "forge.example",
    ),
  ).toBeNull();
});

describe("detectCreatedPullRequest", () => {
  const created = "https://github.com/lopes-felipe/f5/pull/493";

  it("reads Claude's command text from the detail and the URL gh prints last", () => {
    expect(
      detectCreatedPullRequest({
        command: "Bash: {}",
        detail:
          'Bash: cd /tmp/wt && gh pr create --base main --title "fix(html-preview): stop the deadlock" --body-file -',
        output: `Warning: 1 uncommitted change\n${created}\n`,
      }),
    ).toEqual({
      provider: "github",
      host: "github.com",
      repository: "lopes-felipe/f5",
      number: 493,
      title: "fix(html-preview): stop the deadlock",
      url: created,
    });
  });

  it("reads Codex's command text and falls back to a numbered title", () => {
    expect(
      detectCreatedPullRequest({
        command: "/bin/zsh -lc 'gh pr create --fill'",
        detail: null,
        output: created,
      }),
    ).toMatchObject({ number: 493, title: "Pull request #493" });
    expect(
      detectCreatedPullRequest({
        command: "gh pr create -t 'Single quoted' --body x",
        detail: null,
        output: created,
      })?.title,
    ).toBe("Single quoted");
  });

  it("does not take a shell expansion as the title", () => {
    expect(
      detectCreatedPullRequest({
        command: 'gh pr create --title "$(git log -1 --format=%s)"',
        detail: null,
        output: created,
      })?.title,
    ).toBe("Pull request #493");
  });

  it("ignores other gh commands and non-PR URLs", () => {
    expect(
      detectCreatedPullRequest({ command: "gh pr view 493", detail: null, output: created }),
    ).toBeNull();
    expect(
      detectCreatedPullRequest({
        command: "gh api repos/lopes-felipe/f5/pulls/493/comments",
        detail: null,
        output: created,
      }),
    ).toBeNull();
    expect(
      detectCreatedPullRequest({
        command: "gh pr create --fill",
        detail: null,
        output: `${created}#issuecomment-6656341689\n${created}/files`,
      }),
    ).toBeNull();
  });

  it("takes the last PR URL when several appear", () => {
    expect(
      detectCreatedPullRequest({
        command: "gh pr create --fill",
        detail: null,
        output: "See https://github.com/o/r/pull/1 for context.\nhttps://github.com/o/r/pull/2",
      })?.number,
    ).toBe(2);
  });
});

describe("thread pull request links", () => {
  const link = (number: number, title = `PR ${number}`) => ({
    provider: "github" as const,
    host: "github.com",
    repository: "o/r",
    number,
    title,
    url: `https://github.com/o/r/pull/${number}`,
  });

  it("moves a relinked PR to the front without duplicating it", () => {
    const current = [link(2), link(1)];
    expect(updateThreadPullRequestLinks(current, { link: link(1, "Renamed") })).toEqual([
      link(1, "Renamed"),
      link(2),
    ]);
  });

  it("removes an unlinked PR, matching repository case-insensitively", () => {
    const current = [link(2), link(1)];
    expect(
      updateThreadPullRequestLinks(current, {
        unlink: { provider: "github", host: "github.com", repository: "O/R", number: 2 },
      }),
    ).toEqual([link(1)]);
    expect(
      updateThreadPullRequestLinks(current, {
        unlink: { provider: "github", host: "github.com", repository: "o/r", number: 9 },
      }),
    ).toBe(current);
  });

  it("keeps at most the shell limit, newest first", () => {
    let links = updateThreadPullRequestLinks(undefined, {});
    for (let number = 1; number <= 25; number += 1)
      links = updateThreadPullRequestLinks(links, { link: link(number) });
    expect(links).toHaveLength(20);
    expect(links[0]?.number).toBe(25);
    expect(hasThreadPullRequestLink(links, link(5))).toBe(false);
    expect(hasThreadPullRequestLink(links, link(6))).toBe(true);
  });

  it("builds a link with a bounded fallback title", () => {
    const ref = { provider: "github" as const, host: "github.com", repository: "o/r", number: 4 };
    expect(toThreadPullRequestLink(ref, { url: link(4).url, title: "  " })?.title).toBe(
      "Pull request #4",
    );
    expect(toThreadPullRequestLink(ref, { url: "ftp://x" })).toBeNull();
  });
});
