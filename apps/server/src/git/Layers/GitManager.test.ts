import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeGitManager } from "./GitManager.ts";
import { GitHubCliError } from "../Errors.ts";
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
  readonly gitHub?: FakeGitHubCliOptions;
}) {
  const git = makeFakeGitCore(options?.gitCore);
  const github = makeFakeGitHubCli(options?.gitHub);
  const layer = Layer.mergeAll(
    Layer.succeed(GitCore, git.service),
    Layer.succeed(GitHubCli, github.service),
    Layer.succeed(TextGeneration, makeFakeTextGeneration()),
    Layer.succeed(ServerConfig, makeServerConfig()),
    NodeServices.layer,
  );
  const manager = await Effect.runPromise(makeGitManager.pipe(Effect.provide(layer)));
  return { manager, git, github };
}

describe("GitManager unit", () => {
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
    expect(status.changeRequest).toMatchObject({ id: "42", provider: { kind: "unknown" } });
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
