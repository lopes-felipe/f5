import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../../src/config.ts";
import { GitCoreLive } from "../../../src/git/Layers/GitCore.ts";
import { GitServiceLive } from "../../../src/git/Layers/GitService.ts";
import { makeGitManager } from "../../../src/git/Layers/GitManager.ts";
import { GitCore, type GitCoreShape } from "../../../src/git/Services/GitCore.ts";
import { GitHubCli } from "../../../src/git/Services/GitHubCli.ts";
import { GitService, type GitServiceShape } from "../../../src/git/Services/GitService.ts";
import { TextGeneration } from "../../../src/git/Services/TextGeneration.ts";
import { makeFakeGitHubCli, makeFakeTextGeneration } from "../../../src/git/testDoubles.ts";
import { makeLocalPushFriendlyGitServiceLayer } from "../../../src/git/testUtils.ts";
import { ServerSettingsService } from "../../../src/serverSettings.ts";

const tempDirectories: string[] = [];

afterAll(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

const GitServiceTestLayer = makeLocalPushFriendlyGitServiceLayer(
  GitServiceLive.pipe(Layer.provide(NodeServices.layer)),
);
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(GitServiceTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitServiceTestLayer, GitCoreTestLayer);

async function makeServices() {
  return Effect.runPromise(
    Effect.all({ git: Effect.service(GitService), core: Effect.service(GitCore) }).pipe(
      Effect.provide(TestLayer),
    ),
  );
}

async function git(
  service: GitServiceShape,
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  const result = await Effect.runPromise(
    service.execute({ operation: "Git.smoke", cwd, args, timeoutMs: 10_000 }),
  );
  return result.stdout.trim();
}

async function initRepository(service: GitServiceShape, core: GitCoreShape): Promise<string> {
  const cwd = makeTempDirectory("f5-git-smoke-");
  await Effect.runPromise(core.initRepo({ cwd }));
  await git(service, cwd, ["config", "user.email", "test@example.com"]);
  await git(service, cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "initial\n", "utf8");
  await git(service, cwd, ["add", "README.md"]);
  await git(service, cwd, ["commit", "-m", "Initial commit"]);
  await git(service, cwd, ["branch", "-M", "main"]);
  return cwd;
}

async function createBareRemote(service: GitServiceShape): Promise<string> {
  const remote = makeTempDirectory("f5-git-smoke-remote-");
  await git(service, remote, ["init", "--bare"]);
  return remote;
}

function makeServerConfig(baseDir: string): ServerConfigShape {
  const stateDir = path.join(baseDir, "state");
  const logsDir = path.join(stateDir, "logs");
  return {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
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

describe.concurrent("real Git smoke", () => {
  it("initializes a repository and reports status and branches", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);

    const status = await Effect.runPromise(core.statusDetails(cwd));
    const branches = await Effect.runPromise(core.listBranches({ cwd }));

    expect(status).toMatchObject({ branch: "main", hasWorkingTreeChanges: false });
    expect(branches).toMatchObject({ isRepo: true, hasOriginRemote: false });
    expect(branches.branches[0]).toMatchObject({ name: "main", current: true });
  });

  it("creates, checks out, and safely renames a branch", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);

    await Effect.runPromise(core.createBranch({ cwd, branch: "feature/one" }));
    await Effect.runPromise(Effect.scoped(core.checkoutBranch({ cwd, branch: "feature/one" })));
    const renamed = await Effect.runPromise(
      core.renameBranch({ cwd, oldBranch: "feature/one", newBranch: "feature/two" }),
    );

    expect(renamed.branch).toBe("feature/two");
    expect(await git(service, cwd, ["branch", "--show-current"])).toBe("feature/two");
  });

  it("prepares selected changes, commits, and reads range context", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    fs.writeFileSync(path.join(cwd, "README.md"), "updated\n", "utf8");
    fs.writeFileSync(path.join(cwd, "ignored.txt"), "ignored\n", "utf8");

    const context = await Effect.runPromise(core.prepareCommitContext(cwd, ["README.md"]));
    const commit = await Effect.runPromise(core.commit(cwd, "Update readme", "Smoke coverage"));
    const range = await Effect.runPromise(core.readRangeContext(cwd, "HEAD~1"));

    expect(context?.stagedPatch).toContain("updated");
    expect(commit.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(range.commitSummary).toContain("Update readme");
    expect(await git(service, cwd, ["status", "--short"])).toBe("?? ignored.txt");
  });

  it("creates and force-removes a dirty worktree", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    const worktreePath = makeTempDirectory("f5-git-smoke-worktree-");
    fs.rmSync(worktreePath, { recursive: true, force: true });

    const created = await Effect.runPromise(
      core.createWorktree({
        cwd,
        branch: "main",
        newBranch: "feature/worktree",
        path: worktreePath,
      }),
    );
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "dirty\n", "utf8");
    await Effect.runPromise(core.removeWorktree({ cwd, path: worktreePath, force: true }));

    expect(created.worktree.branch).toBe("feature/worktree");
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it("sets upstream on local push and skips a second up-to-date push", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    const remote = await createBareRemote(service);
    await git(service, cwd, ["remote", "add", "origin", remote]);

    const first = await Effect.runPromise(core.pushCurrentBranch(cwd, "main"));
    const second = await Effect.runPromise(core.pushCurrentBranch(cwd, "main"));

    expect(first).toMatchObject({ status: "pushed", branch: "main", setUpstream: true });
    expect(second).toMatchObject({ status: "skipped_up_to_date", branch: "main" });
    expect(await git(service, remote, ["rev-parse", "refs/heads/main"])).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("pulls a commit created by another clone", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    const remote = await createBareRemote(service);
    await git(service, cwd, ["remote", "add", "origin", remote]);
    await git(service, cwd, ["push", "-u", "origin", "main"]);

    const peer = makeTempDirectory("f5-git-smoke-peer-");
    await git(service, peer, ["clone", remote, "."]);
    await git(service, peer, ["config", "user.email", "peer@example.com"]);
    await git(service, peer, ["config", "user.name", "Peer"]);
    fs.writeFileSync(path.join(peer, "peer.txt"), "peer\n", "utf8");
    await git(service, peer, ["add", "peer.txt"]);
    await git(service, peer, ["commit", "-m", "Peer commit"]);
    await git(service, peer, ["push", "origin", "main"]);

    const pulled = await Effect.runPromise(core.pullCurrentBranch(cwd));

    expect(pulled.status).toBe("pulled");
    expect(fs.readFileSync(path.join(cwd, "peer.txt"), "utf8")).toBe("peer\n");
  });

  it("fetches a PR ref and reuses an existing remote by URL", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    const remote = await createBareRemote(service);
    const headSha = await git(service, cwd, ["rev-parse", "HEAD"]);
    await git(service, cwd, ["remote", "add", "origin", remote]);
    await git(service, cwd, ["push", "origin", "HEAD:main"]);
    await git(service, remote, ["update-ref", "refs/pull/7/head", headSha]);

    await Effect.runPromise(
      core.fetchPullRequestBranch({ cwd, prNumber: 7, branch: "review/pr-7" }),
    );
    const remoteName = await Effect.runPromise(
      core.ensureRemote({ cwd, preferredName: "duplicate", url: remote }),
    );

    expect(remoteName).toBe("origin");
    expect(await git(service, cwd, ["rev-parse", "review/pr-7"])).toBe(headSha);
  });

  it("runs an integrated feature-branch commit, push, and PR workflow", async () => {
    const { git: service, core } = await makeServices();
    const cwd = await initRepository(service, core);
    const remote = await createBareRemote(service);
    await git(service, cwd, ["remote", "add", "origin", remote]);
    await git(service, cwd, ["push", "-u", "origin", "main"]);
    fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n", "utf8");

    const createdPr = {
      number: 91,
      title: "Generated pull request",
      url: "https://github.com/t3tools/f5/pull/91",
      baseRefName: "main",
      headRefName: "feature/generated-commit",
      state: "open" as const,
    };
    const github = makeFakeGitHubCli({ pullRequestSequence: [[], [createdPr]] });
    const managerLayer = Layer.mergeAll(
      Layer.succeed(GitCore, core),
      Layer.succeed(GitHubCli, github.service),
      Layer.succeed(TextGeneration, makeFakeTextGeneration()),
      Layer.succeed(ServerConfig, makeServerConfig(makeTempDirectory("f5-git-smoke-manager-"))),
      ServerSettingsService.layerTest(),
      NodeServices.layer,
    );
    const manager = await Effect.runPromise(makeGitManager.pipe(Effect.provide(managerLayer)));

    const result = await Effect.runPromise(
      manager.runStackedAction({ cwd, action: "commit_push_pr", featureBranch: true }),
    );

    expect(result).toMatchObject({
      branch: { status: "created", name: "feature/generated-commit" },
      commit: { status: "created" },
      push: { status: "pushed" },
      pr: { status: "created", number: 91 },
    });
    expect(
      await git(service, remote, ["rev-parse", "refs/heads/feature/generated-commit"]),
    ).toMatch(/^[0-9a-f]{40}$/u);
  });
});
