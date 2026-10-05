import { PersistenceSqlError } from "../../persistence/Errors";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ProjectionProject } from "../../persistence/Services/ProjectionProjects";
import type { TextGenerationShape } from "../Services/TextGeneration";
import { makeGitProjectRepositories } from "../testDoubles";
import { emptyGitProjectRepositories } from "../testDoubles";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ForgeAccounts, type ForgeAccountsShape } from "../../sourceControl/accountRouting.ts";
import { makeGitManager } from "./GitManager.ts";
import { GitCommandError, GitHubCliError } from "../Errors.ts";
import { GitCore, type GitCoreShape, type GitStatusDetails } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import {
  makeFakeGitCore,
  makeFakeGitHubCli,
  makeFakeTextGeneration,
  type FakeGitHubCliOptions,
} from "../testDoubles.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const cwd = process.cwd();

const cleanStatus: GitStatusDetails = {
  branch: "feature/test",
  upstreamRef: "origin/feature/test",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
};

const dirtyStatus: GitStatusDetails = {
  ...cleanStatus,
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "src/change.ts", insertions: 4, deletions: 1 }],
    insertions: 4,
    deletions: 1,
  },
};

function makeServerConfig(): ServerConfigShape {
  const baseDir = path.join(process.env.TMPDIR ?? "/tmp", "f5-git-manager-unit");
  const stateDir = path.join(baseDir, "state");
  const logsDir = path.join(stateDir, "logs");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd,
    baseDir,
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    worktreesDir: path.join(baseDir, "worktrees"),
    attachmentsDir: path.join(stateDir, "attachments"),
    logsDir,
    serverLogPath: path.join(logsDir, "server.log"),
    providerLogsDir: path.join(logsDir, "provider"),
    providerEventLogPath: path.join(logsDir, "provider", "events.log"),
    terminalLogsDir: path.join(logsDir, "terminals"),
    anonymousIdPath: path.join(stateDir, "anonymous-id"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    observabilityEnabled: false,
    acpHardeningEnabled: false,
  };
}

async function makeManager(options?: {
  readonly gitCore?: Partial<GitCoreShape>;
  readonly settings?: Partial<ServerSettings>;
  readonly projectLookup?: Parameters<typeof makeGitProjectRepositories>[1];
  readonly projects?: readonly ProjectionProject[];
  readonly textGeneration?: Partial<TextGenerationShape>;
  readonly gitHub?: FakeGitHubCliOptions;
  readonly forgeAccounts?: ForgeAccountsShape;
}) {
  const git = makeFakeGitCore(options?.gitCore);
  const github = makeFakeGitHubCli(options?.gitHub);
  const layer = Layer.mergeAll(
    Layer.succeed(GitCore, git.service),
    Layer.succeed(GitHubCli, github.service),
    Layer.succeed(TextGeneration, makeFakeTextGeneration(options?.textGeneration)),
    Layer.succeed(ServerConfig, makeServerConfig()),
    ServerSettingsService.layerTest(options?.settings),
    makeGitProjectRepositories(options?.projects, options?.projectLookup),
    NodeServices.layer,
  );
  const run = makeGitManager.pipe(Effect.provide(layer));
  const manager = await Effect.runPromise(
    options?.forgeAccounts
      ? run.pipe(Effect.provideService(ForgeAccounts, options.forgeAccounts))
      : run,
  );
  return { manager, git, github };
}

describe("GitManager unit", () => {
  it("fails before Git mutations when project settings cannot be resolved", async () => {
    const { manager, git } = await makeManager({
      projectLookup: () =>
        Effect.fail(new PersistenceSqlError({ operation: "listAll", detail: "unavailable" })),
    });
    await expect(
      Effect.runPromise(manager.runStackedAction({ cwd, action: "commit", featureBranch: true })),
    ).rejects.toThrow("unavailable");
    expect(Object.values(git.calls).flat()).toEqual([]);
  });
  it("uses the project's writing preferences and text generation account", async () => {
    const projectId = ProjectId.makeUnsafe("git-project");
    const selected = { instanceId: ProviderInstanceId.makeUnsafe("codex"), model: "project-model" };
    let captured: Parameters<TextGenerationShape["generateCommitMessage"]>[0] | undefined;
    const { manager } = await makeManager({
      projects: [
        {
          projectId,
          title: "Git project",
          workspaceRoot: cwd,
          defaultModel: null,
          scripts: [],
          createdAt: "2026-09-29T00:00:00Z",
          updatedAt: "2026-09-29T00:00:00Z",
          deletedAt: null,
        },
      ],
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            textGenerationModelSelection: selected,
            sourceControlWriting: {
              ...DEFAULT_SERVER_SETTINGS.sourceControlWriting,
              customInstructions: "Project instructions",
            },
          },
        },
      },
      gitCore: {
        statusDetails: () => Effect.succeed(dirtyStatus),
        prepareCommitContext: () =>
          Effect.succeed({ stagedSummary: "1 file changed", stagedPatch: "+change" }),
      },
      textGeneration: {
        generateCommitMessage: (input) => {
          captured = input;
          return Effect.succeed({ subject: "Scoped commit", body: "" });
        },
      },
    });
    await Effect.runPromise(manager.runStackedAction({ cwd, action: "commit" }));
    expect(captured?.modelSelection).toEqual(selected);
    expect(captured?.writingPreferences?.customInstructions).toBe("Project instructions");
  });

  it("returns missing worktree status without running git", async () => {
    const { manager, git, github } = await makeManager();
    const status = await Effect.runPromise(
      manager.status({ cwd: path.join(cwd, `missing-${crypto.randomUUID()}`) }),
    );
    expect(status.worktreeMissing).toBe(true);
    expect(Object.values(git.calls).flat()).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it("adds current pull-request metadata to Git status", async () => {
    const { manager } = await makeManager({
      gitCore: { statusDetails: () => Effect.succeed(cleanStatus) },
      gitHub: {
        pullRequests: [
          {
            number: 42,
            title: "Fast tests",
            url: "https://github.com/t3tools/f5/pull/42",
            baseRefName: "main",
            headRefName: "feature/test",
            state: "open",
          },
        ],
      },
    });

    const status = await Effect.runPromise(manager.status({ cwd }));

    expect(status.pr).toEqual({
      number: 42,
      title: "Fast tests",
      url: "https://github.com/t3tools/f5/pull/42",
      baseBranch: "main",
      headBranch: "feature/test",
      state: "open",
    });
    expect(status.changeRequest).toMatchObject({
      id: "42",
      provider: { kind: "github", remoteName: "origin" },
    });
  });

  it("fails closed instead of dispatching GitHub operations for unsupported remotes", async () => {
    const { manager, github } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(cleanStatus),
        listRemotes: () =>
          Effect.succeed([{ name: "origin", url: "git@gitlab.com:octo/repo.git" }]),
      },
    });

    const status = await Effect.runPromise(manager.status({ cwd }));
    expect(status.pr).toBeNull();
    expect(status.changeRequest).toBeNull();
    expect(github.calls).toEqual([]);

    await expect(
      Effect.runPromise(manager.resolvePullRequest({ cwd, reference: "7" })),
    ).rejects.toThrow("Configure a forge account");
    expect(github.calls).toEqual([]);
  });

  it("keeps status usable when pull-request lookup fails", async () => {
    const github = makeFakeGitHubCli();
    const failingGithub = {
      ...github.service,
      execute: () =>
        Effect.fail(
          new GitHubCliError({ operation: "execute", detail: "gh unavailable", kind: "generic" }),
        ),
    };
    const git = makeFakeGitCore({ statusDetails: () => Effect.succeed(cleanStatus) });
    const layer = Layer.mergeAll(
      Layer.succeed(GitCore, git.service),
      Layer.succeed(GitHubCli, failingGithub),
      Layer.succeed(TextGeneration, makeFakeTextGeneration()),
      Layer.succeed(ServerConfig, makeServerConfig()),
      ServerSettingsService.layerTest(),
      emptyGitProjectRepositories,
      NodeServices.layer,
    );
    const manager = await Effect.runPromise(makeGitManager.pipe(Effect.provide(layer)));

    const status = await Effect.runPromise(manager.status({ cwd }));

    expect(status.pr).toBeNull();
    expect(status.branch).toBe("feature/test");
  });

  it("skips commit cleanly when no staged context exists", async () => {
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(cleanStatus),
        prepareCommitContext: () => Effect.succeed(null),
      },
    });

    const result = await Effect.runPromise(manager.runStackedAction({ cwd, action: "commit" }));

    expect(result.commit).toEqual({ status: "skipped_no_changes" });
    expect(git.calls.commit).toHaveLength(0);
  });

  it("generates and creates a commit through GitCore", async () => {
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(dirtyStatus),
        prepareCommitContext: () =>
          Effect.succeed({ stagedSummary: "1 file changed", stagedPatch: "+fast" }),
      },
    });

    const result = await Effect.runPromise(manager.runStackedAction({ cwd, action: "commit" }));

    expect(result.commit).toEqual({
      status: "created",
      commitSha: "abc123",
      subject: "Generated commit",
    });
    expect(git.calls.commit).toEqual([[cwd, "Generated commit", "Generated body"]]);
  });

  it("forwards selected files and preserves a custom subject/body", async () => {
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(dirtyStatus),
        prepareCommitContext: () =>
          Effect.succeed({ stagedSummary: "selected", stagedPatch: "+selected" }),
      },
    });

    await Effect.runPromise(
      manager.runStackedAction({
        cwd,
        action: "commit",
        filePaths: ["src/selected.ts"],
        commitMessage: "Custom subject\n\nCustom body",
      }),
    );

    expect(git.calls.prepareCommitContext).toEqual([[cwd, ["src/selected.ts"]]]);
    expect(git.calls.commit).toEqual([[cwd, "Custom subject", "Custom body"]]);
  });

  it("creates and checks out a collision-safe feature branch before committing", async () => {
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(dirtyStatus),
        prepareCommitContext: () =>
          Effect.succeed({ stagedSummary: "change", stagedPatch: "+change" }),
        listLocalBranchNames: () =>
          Effect.succeed(["main", "feature/generated-commit", "feature/generated-commit-1"]),
      },
    });

    const result = await Effect.runPromise(
      manager.runStackedAction({ cwd, action: "commit_push", featureBranch: true }),
    );

    expect(result.branch).toEqual({ status: "created", name: "feature/generated-commit-2" });
    expect(git.calls.createBranch).toEqual([[{ cwd, branch: "feature/generated-commit-2" }]]);
    expect(git.calls.checkoutBranch).toEqual([[{ cwd, branch: "feature/generated-commit-2" }]]);
    expect(git.calls.pushCurrentBranch).toEqual([[cwd, "feature/generated-commit-2"]]);
  });

  it("rejects push actions from detached HEAD before mutating Git", async () => {
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed({ ...cleanStatus, branch: null, upstreamRef: null }),
      },
    });

    await expect(
      Effect.runPromise(manager.runStackedAction({ cwd, action: "commit_push" })),
    ).rejects.toThrow("Cannot push from detached HEAD");
    expect(git.calls.prepareCommitContext).toHaveLength(0);
  });

  it("returns an existing PR without generating or creating another", async () => {
    const existing = {
      number: 17,
      title: "Existing PR",
      url: "https://github.com/t3tools/f5/pull/17",
      baseRefName: "main",
      headRefName: "feature/test",
      state: "open" as const,
    };
    const { manager, github } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(cleanStatus),
        prepareCommitContext: () => Effect.succeed(null),
      },
      gitHub: { pullRequests: [existing] },
    });

    const result = await Effect.runPromise(
      manager.runStackedAction({ cwd, action: "commit_push_pr" }),
    );

    expect(result.pr).toMatchObject({ status: "opened_existing", number: 17 });
    expect(github.calls.some((call) => call.startsWith("createPullRequest:"))).toBe(false);
  });

  it("creates a PR and confirms it with a second lookup", async () => {
    const created = {
      number: 18,
      title: "Generated pull request",
      url: "https://github.com/t3tools/f5/pull/18",
      baseRefName: "main",
      headRefName: "feature/test",
      state: "open" as const,
    };
    const { manager, github, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(cleanStatus),
        prepareCommitContext: () => Effect.succeed(null),
      },
      gitHub: { pullRequestSequence: [[], [created]] },
    });

    const result = await Effect.runPromise(
      manager.runStackedAction({ cwd, action: "commit_push_pr" }),
    );

    expect(result.pr).toMatchObject({ status: "created", number: 18, baseBranch: "main" });
    expect(github.calls).toContain("createPullRequest:main:feature/test");
    expect(git.calls.readRangeContext).toEqual([[cwd, "main"]]);
  });

  it("normalizes number references when resolving a pull request", async () => {
    const { manager, github } = await makeManager();

    const result = await Effect.runPromise(manager.resolvePullRequest({ cwd, reference: "#42" }));

    expect(result.pullRequest.number).toBe(42);
    expect(github.calls).toContain("getPullRequest:42");
  });

  it("prepares a local PR thread through the GitHub checkout boundary", async () => {
    const { manager, github } = await makeManager({
      gitCore: { statusDetails: () => Effect.succeed(cleanStatus) },
    });

    const result = await Effect.runPromise(
      manager.preparePullRequestThread({ cwd, reference: "42", mode: "local" }),
    );

    expect(result).toMatchObject({ branch: "feature/test", worktreePath: null });
    expect(github.calls).toContain("checkoutPullRequest:42");
  });

  it("materializes a PR branch and creates a dedicated worktree", async () => {
    const worktreePath = "/tmp/f5-pr-worktree";
    const { manager, git } = await makeManager({
      gitCore: {
        statusDetails: () => Effect.succeed(cleanStatus),
        listBranches: () => Effect.succeed({ branches: [], isRepo: true, hasOriginRemote: true }),
        createWorktree: () =>
          Effect.succeed({ worktree: { path: worktreePath, branch: "feature/test" } }),
      },
    });

    const result = await Effect.runPromise(
      manager.preparePullRequestThread({ cwd, reference: "42", mode: "worktree" }),
    );

    expect(result).toMatchObject({ branch: "feature/test", worktreePath });
    expect(git.calls.fetchPullRequestBranch).toEqual([
      [{ cwd, prNumber: 42, branch: "feature/test" }],
    ]);
    expect(git.calls.createWorktree).toHaveLength(1);
  });

  it("rejects a stale expected PR head before checkout or fetch", async () => {
    const { manager, github, git } = await makeManager();

    await expect(
      Effect.runPromise(
        manager.preparePullRequestThread({
          cwd,
          reference: "42",
          mode: "worktree",
          expectedHeadOid: "outdated",
        }),
      ),
    ).rejects.toThrow("Pull request head changed before checkout");
    expect(github.calls.some((call) => call.startsWith("checkoutPullRequest:"))).toBe(false);
    expect(git.calls.fetchPullRequestBranch).toHaveLength(0);
  });
});

it("does not write tracking config if the index locks after PR checkout", async () => {
  let reads = 0;
  const { manager, git, github } = await makeManager({
    gitCore: {
      statusDetails: () =>
        ++reads === 1
          ? Effect.succeed({ ...cleanStatus, branch: "main" })
          : Effect.fail(
              new GitCommandError({
                operation: "status",
                command: "git status",
                cwd,
                detail: "Git index is locked.",
              }),
            ),
    },
    gitHub: {
      pullRequest: {
        number: 42,
        title: "Fork PR",
        url: "https://github.com/t3tools/f5/pull/42",
        baseRefName: "main",
        headRefName: "feature",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "contributor/f5",
        headRepositoryOwnerLogin: "contributor",
      },
    },
  });
  const result = await Effect.runPromise(
    manager.preparePullRequestThread({ cwd, reference: "42", mode: "local" }).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(github.calls).toContain("checkoutPullRequest:42");
  expect(git.calls.setBranchUpstream).toEqual([]);
});

function forgeAccountFixture(): ForgeAccountsShape {
  const a = {
    id: "forge-account",
    provider: "gitlab" as const,
    host: "gitlab.com",
    login: "reviewer",
    viewerId: "42",
    generation: "1",
  };
  return {
    removeAccount: () => Effect.void,
    listAccounts: () => Effect.succeed([a]),
    saveAccount: () => Effect.succeed(a),
    getToken: () => Effect.succeed("token"),
    route: () => Effect.succeed(a),
    removeRouting: () => Effect.void,
    setRouting: () => Effect.void,
    listRouting: () => Effect.succeed([]),
    resolveAccount: ({ ref }) =>
      Effect.succeed({
        ...a,
        kind: a.provider,
        token: "token",
        repository: ref?.repository ?? "team/repo",
      }),
  };
}
it("preserves profile GitHub behavior when the account service has no managed host account", async () => {
  const fixture = forgeAccountFixture();
  const { manager, github } = await makeManager({
    forgeAccounts: {
      ...fixture,
      removeAccount: () => Effect.void,
      listAccounts: () => Effect.succeed([]),
      resolveAccount: () =>
        Effect.die("An empty account service must not resolve managed credentials"),
    },
    gitCore: {
      listRemotes: () => Effect.succeed([{ name: "origin", url: "git@github.com:team/repo.git" }]),
    },
  });
  await Effect.runPromise(manager.preparePullRequestThread({ cwd, reference: "7", mode: "local" }));
  expect(github.calls).toContain("getPullRequest:7");
});
it("routes native forge status and preserves dirty local work before checkout", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          iid: 7,
          title: "Native MR",
          web_url: "https://gitlab.com/team/repo/-/merge_requests/7",
          source_branch: "feature/test",
          target_branch: "main",
          state: "opened",
          sha: "head-sha",
        }),
        { status: 200 },
      ),
  );
  try {
    const { manager, git, github } = await makeManager({
      forgeAccounts: forgeAccountFixture(),
      gitCore: {
        listRemotes: () =>
          Effect.succeed([{ name: "origin", url: "git@gitlab.com:team/repo.git" }]),
        statusDetails: () => Effect.succeed(dirtyStatus),
      },
    });
    await expect(
      Effect.runPromise(manager.preparePullRequestThread({ cwd, reference: "7", mode: "local" })),
    ).rejects.toThrow("Commit or stash");
    expect(git.calls.fetchRemoteBranch).toHaveLength(0);
    expect(git.calls.checkoutBranch).toHaveLength(0);
    expect(github.calls).toHaveLength(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("preserves an existing forge branch with a different commit", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          iid: 7,
          title: "Native MR",
          web_url: "https://gitlab.com/team/repo/-/merge_requests/7",
          source_branch: "feature/test",
          target_branch: "main",
          state: "opened",
          sha: "remote-sha",
        }),
        { status: 200 },
      ),
  );
  try {
    const { manager, git, github } = await makeManager({
      forgeAccounts: forgeAccountFixture(),
      gitCore: {
        listRemotes: () =>
          Effect.succeed([{ name: "origin", url: "git@gitlab.com:team/repo.git" }]),
        statusDetails: () => Effect.succeed(cleanStatus),
        listLocalBranchNames: () => Effect.succeed(["feature/test"]),
        resolveCommit: () => Effect.succeed("local-work-sha"),
      },
    });
    await expect(
      Effect.runPromise(manager.preparePullRequestThread({ cwd, reference: "7", mode: "local" })),
    ).rejects.toThrow("different commit");
    expect(git.calls.fetchRemoteBranch).toHaveLength(0);
    expect(git.calls.checkoutBranch).toHaveLength(0);
    expect(github.calls).toHaveLength(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
