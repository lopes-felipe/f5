import { ServerConfig } from "../../config.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  PlatformError,
  Scope,
  ServiceMap,
} from "effect";
import { describe, expect, vi } from "vitest";

import { GitServiceLive } from "./GitService.ts";
import { GitService, type GitServiceShape } from "../Services/GitService.ts";
import { GitCoreTestLive as GitCoreLive } from "../testLayers.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCommandError } from "../Errors.ts";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { makeLocalPushFriendlyGitServiceLayer } from "../testUtils.ts";
import { parseWorktreeListPorcelain } from "../worktreeList.ts";

// ── Helpers ──

const GitServiceTestLayer = makeLocalPushFriendlyGitServiceLayer(
  GitServiceLive.pipe(Layer.provide(NodeServices.layer)),
);
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-git-core-" })),
  Layer.provide(GitServiceTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitServiceTestLayer, GitCoreTestLayer);

function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const core = yield* Effect.serviceOption(GitCore);
    if (core._tag === "Some" && core.value.drainUpstreamRefreshes)
      yield* Effect.addFinalizer(() => core.value.drainUpstreamRefreshes!(directory));
    return directory;
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

/** Run a raw git command for test setup (not under test). */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitService> {
  return Effect.gen(function* () {
    const gitService = yield* GitService;
    const result = yield* gitService.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() => {
    const shellPath =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");

    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

    return runProcess(shellPath, args, {
      env: process.env,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      allowNonZeroExit: true,
      maxBufferBytes: input.maxOutputBytes ?? 1_000_000,
      outputMode: "truncate",
    });
  });
}

const makeIsolatedGitCore = (gitService: GitServiceShape) =>
  Effect.gen(function* () {
    const coreLayer = GitCoreLive.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-git-core-" })),
      Layer.provide(Layer.succeed(GitService, gitService)),
      Layer.provide(NodeServices.layer),
    );
    // Keep service-scoped refresh fibers alive until the surrounding test ends.
    return ServiceMap.get(yield* Layer.build(Layer.fresh(coreLayer)), GitCore);
  });

function listGitBranches(input: Parameters<GitCoreShape["listBranches"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.listBranches(input);
  });
}

function initGitRepo(input: Parameters<GitCoreShape["initRepo"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.initRepo(input);
  });
}

function createGitBranch(input: Parameters<GitCoreShape["createBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.createBranch(input);
  });
}

function checkoutGitBranch(input: Parameters<GitCoreShape["checkoutBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.checkoutBranch(input);
  });
}

function createGitWorktree(input: Parameters<GitCoreShape["createWorktree"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.createWorktree(input);
  });
}

function fetchGitPullRequestBranch(input: Parameters<GitCoreShape["fetchPullRequestBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.fetchPullRequestBranch(input);
  });
}

function removeGitWorktree(input: Parameters<GitCoreShape["removeWorktree"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.removeWorktree(input);
  });
}

function renameGitBranch(input: Parameters<GitCoreShape["renameBranch"]>[0]) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.renameBranch(input);
  });
}

function pullGitBranch({ cwd }: { cwd: string }) {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    return yield* core.pullCurrentBranch(cwd);
  });
}

/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitCore | GitService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* initGitRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* git(cwd, ["config", "commit.gpgSign", "false"]);
    yield* git(cwd, ["config", "tag.gpgSign", "false"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });
}

function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* writeTextFile(path.join(cwd, fileName), fileContents);
    yield* git(cwd, ["add", fileName]);
    yield* git(cwd, ["commit", "-m", message], {
      ...process.env,
      GIT_AUTHOR_DATE: dateIsoString,
      GIT_COMMITTER_DATE: dateIsoString,
    });
  });
}

// ── Tests ──

it.layer(TestLayer)("git integration", (it) => {
  describe("commit generation isolation", () => {
    for (const split of [false, true]) {
      it.effect(
        `preserves partial staging and materializes a temporary index (split=${split})`,
        () =>
          Effect.gen(function* () {
            const cwd = yield* makeTmpDir();
            yield* initRepoWithCommit(cwd);
            const core = yield* GitCore;
            const fs = yield* FileSystem.FileSystem;
            yield* writeTextFile(path.join(cwd, "README.md"), "staged content\n");
            yield* git(cwd, ["add", "README.md"]);
            yield* writeTextFile(path.join(cwd, "README.md"), "included worktree content\n");
            yield* writeTextFile(path.join(cwd, "other.txt"), "leave untracked\n");
            if (split) yield* git(cwd, ["update-index", "--split-index"]);
            const indexPath = path.resolve(
              cwd,
              yield* git(cwd, ["rev-parse", "--git-path", "index"]),
            );
            const before = yield* fs.readFile(indexPath);
            const context = yield* core.prepareCommitContext(cwd, ["README.md"]);
            expect(context?.stagedPatch).toContain("included worktree content");
            expect(context?.stagedPatch).not.toContain("other.txt");
            expect(yield* fs.readFile(indexPath)).toEqual(before);
            expect(
              (yield* fs.readDirectory(path.dirname(indexPath))).filter((name) =>
                name.startsWith("index.f5-"),
              ),
            ).toEqual([]);
            const committed = yield* core.commitPrepared(cwd, "Selected content", "", context!);
            expect(committed.status).toBe("created");
            expect(yield* git(cwd, ["show", "HEAD:README.md"])).toBe("included worktree content");
            expect(yield* git(cwd, ["status", "--porcelain"])).toBe("?? other.txt");
          }),
      );
    }

    it.effect("commits after another tool refreshes the index without changing staging", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        yield* writeTextFile(path.join(cwd, "stable.txt"), "unchanged\n");
        yield* git(cwd, ["add", "stable.txt"]);
        yield* git(cwd, ["commit", "-m", "Add stable file"]);
        yield* writeTextFile(path.join(cwd, "README.md"), "suggested content\n");
        const context = yield* core.prepareCommitContext(cwd, ["README.md"]);
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        const before = yield* fs.readFile(indexPath);
        // What an IDE's `git status` does: new stat data for a file, rewritten into the index.
        const later = new Date(Date.now() + 60_000);
        yield* fs.utimes(path.join(cwd, "stable.txt"), later, later);
        yield* git(cwd, ["update-index", "-q", "--refresh"]);
        expect(yield* fs.readFile(indexPath)).not.toEqual(before);

        expect((yield* core.commitPrepared(cwd, "Suggested", "", context!)).status).toBe("created");
        expect(yield* git(cwd, ["show", "HEAD:README.md"])).toBe("suggested content");
      }),
    );

    for (const changed of ["index", "head", "included", "deleted"] as const) {
      it.effect(`refuses changed ${changed} after generation without replacing staging`, () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const core = yield* GitCore;
          const fs = yield* FileSystem.FileSystem;
          yield* writeTextFile(path.join(cwd, "README.md"), "suggested content\n");
          const context = yield* core.prepareCommitContext(cwd, ["README.md"]);
          if (changed === "index") {
            yield* writeTextFile(path.join(cwd, "concurrent.txt"), "another client's staging\n");
            yield* git(cwd, ["add", "concurrent.txt"]);
          } else if (changed === "head") {
            yield* git(cwd, ["commit", "--allow-empty", "-m", "Concurrent HEAD"]);
          } else if (changed === "included") {
            yield* writeTextFile(path.join(cwd, "README.md"), "new edit while model ran\n");
          } else yield* fs.remove(path.join(cwd, "README.md"));
          const indexPath = path.resolve(
            cwd,
            yield* git(cwd, ["rev-parse", "--git-path", "index"]),
          );
          const before = yield* fs.readFile(indexPath);
          expect(
            yield* core.commitPrepared(cwd, "Stale suggestion", "", context!, {
              newBranch: "stale-branch",
            }),
          ).toEqual({ status: "context_changed" });
          expect(yield* fs.readFile(indexPath)).toEqual(before);
          expect(yield* core.branchExists(cwd, "stale-branch")).toBe(false);
          expect(
            (yield* fs.readDirectory(path.dirname(indexPath))).filter((name) =>
              name.startsWith("index.f5-"),
            ),
          ).toEqual([]);
        }),
      );
    }

    it.effect(
      "allows unrelated edits outside the selected paths and commits on the requested branch",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const core = yield* GitCore;
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* writeTextFile(path.join(cwd, "README.md"), "selected\n");
          const context = yield* core.prepareCommitContext(cwd, ["README.md"]);
          yield* writeTextFile(path.join(cwd, "unrelated.txt"), "unrelated\n");
          expect(
            (yield* core.commitPrepared(cwd, "Feature", "", context!, {
              newBranch: "feature/prepared",
            })).status,
          ).toBe("created");
          expect(yield* git(cwd, ["branch", "--show-current"])).toBe("feature/prepared");
          expect(yield* git(cwd, ["rev-parse", "HEAD~1"])).toBe(head);
          expect(yield* git(cwd, ["status", "--porcelain"])).toBe("?? unrelated.txt");
        }),
    );

    it.effect("preserves same-size racy edits when copying an old index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        const file = path.join(cwd, "README.md");
        const past = 1_600_000_000;
        yield* git(cwd, ["config", "core.trustctime", "false"]);
        yield* git(cwd, ["config", "core.checkStat", "minimal"]);
        yield* writeTextFile(file, "baseline\n");
        yield* fs.utimes(file, past, past);
        yield* git(cwd, ["add", "README.md"]);
        yield* git(cwd, ["commit", "-m", "Old file timestamp"]);
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        yield* fs.utimes(indexPath, past, past);
        const before = yield* fs.readFile(indexPath);
        yield* writeTextFile(file, "modified\n");
        yield* fs.utimes(file, past, past);
        const context = yield* core.prepareCommitContext(cwd, ["README.md"]);
        expect(context?.stagedPatch).toContain("+modified");
        expect(yield* fs.readFile(indexPath)).toEqual(before);
      }),
    );

    it.effect("seeds an unborn repository without creating the real index during generation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initGitRepo({ cwd });
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        yield* writeTextFile(path.join(cwd, "first.txt"), "first content\n");
        const context = yield* core.prepareCommitContext(cwd);
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        expect(yield* fs.exists(indexPath)).toBe(false);
        expect(context?.stagedPatch).toContain("first content");
        expect((yield* core.commitPrepared(cwd, "Initial", "", context!)).status).toBe("created");
      }),
    );

    it.effect("seeds from HEAD when the real index is missing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        yield* fs.remove(indexPath);
        yield* writeTextFile(path.join(cwd, "README.md"), "updated\n");
        const context = yield* core.prepareCommitContext(cwd);
        expect(context?.stagedSummary).toContain("README.md");
        expect(yield* fs.exists(indexPath)).toBe(false);
        expect(
          (yield* core.commitPrepared(cwd, "Rebuild missing index", "", context!)).status,
        ).toBe("created");
      }),
    );

    it.effect("keeps an unresolved conflict index intact and cleans up a failed preparation", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        yield* git(cwd, ["checkout", "-b", "conflicting"]);
        yield* writeTextFile(path.join(cwd, "README.md"), "other branch\n");
        yield* git(cwd, ["commit", "-am", "Other branch"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(path.join(cwd, "README.md"), "original branch\n");
        yield* git(cwd, ["commit", "-am", "Original branch"]);
        const service = yield* GitService;
        const merged = yield* service.execute({
          operation: "test.conflict",
          cwd,
          args: ["merge", "conflicting"],
          allowNonZeroExit: true,
        });
        expect(merged.code).not.toBe(0);
        yield* writeTextFile(path.join(cwd, "selected.txt"), "selected\n");
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        const before = yield* fs.readFile(indexPath);
        expect(
          (yield* core.prepareCommitContext(cwd, ["selected.txt"]).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* fs.readFile(indexPath)).toEqual(before);
        expect(
          (yield* fs.readDirectory(path.dirname(indexPath))).filter((name) =>
            name.startsWith("index.f5-"),
          ),
        ).toEqual([]);
      }),
    );

    it.effect("cleans the temporary index when generation context is cancelled", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fs = yield* FileSystem.FileSystem;
        const delegate = yield* GitService;
        const entered = yield* Deferred.make<void>();
        const isolated = yield* makeIsolatedGitCore({
          execute: (input) =>
            input.operation === "GitCore.prepareCommitContext.stagedPatch"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : delegate.execute(input),
        });
        yield* writeTextFile(path.join(cwd, "README.md"), "cancelled\n");
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        const before = yield* fs.readFile(indexPath);
        const pending = yield* isolated.prepareCommitContext(cwd).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(
          (yield* fs.readDirectory(path.dirname(indexPath))).some((name) =>
            name.startsWith("index.f5-"),
          ),
        ).toBe(true);
        yield* Fiber.interrupt(pending);
        expect(yield* fs.readFile(indexPath)).toEqual(before);
        expect(
          (yield* fs.readDirectory(path.dirname(indexPath))).filter((name) =>
            name.startsWith("index.f5-"),
          ),
        ).toEqual([]);
      }),
    );
  });

  describe("upstream Git safety", () => {
    it.effect(
      "keeps branches used by any registered checkout and compares unused refs atomically",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const core = yield* GitCore;
          const head = yield* git(cwd, ["rev-parse", "HEAD"]);
          expect(
            yield* core.deleteBranchIfAt({
              cwd,
              branch: initialBranch,
              expectedSha: head,
              onlyIfUnused: true,
            }),
          ).toBe(false);
          yield* core.createBranch({ cwd, branch: "used-topic" });
          const worktree = path.join(yield* makeTmpDir(), "linked");
          yield* git(cwd, ["worktree", "add", "--", worktree, "used-topic"]);
          expect(
            yield* core.deleteBranchIfAt({
              cwd,
              branch: "used-topic",
              expectedSha: head,
              onlyIfUnused: true,
            }),
          ).toBe(false);
          yield* core.createBranch({ cwd, branch: "unused-topic" });
          expect(
            yield* core.deleteBranchIfAt({
              cwd,
              branch: "unused-topic",
              expectedSha: "b".repeat(40),
              onlyIfUnused: true,
            }),
          ).toBe(false);
          expect(yield* core.resolveCommit(cwd, "refs/heads/unused-topic")).toBe(head);
          expect(
            yield* core.deleteBranchIfAt({
              cwd,
              branch: "unused-topic",
              expectedSha: head,
              onlyIfUnused: true,
            }),
          ).toBe(true);
          expect(yield* core.resolveCommit(cwd, "refs/heads/used-topic")).toBe(head);
        }),
    );
    it.effect("deletes only the named branch when it has become a symbolic ref", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["symbolic-ref", "refs/heads/safety-alias", `refs/heads/${initialBranch}`]);
        expect(
          yield* core.deleteBranchIfAt({ cwd, branch: "safety-alias", expectedSha: head }),
        ).toBe(true);
        expect(yield* git(cwd, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* git(cwd, ["symbolic-ref", "--quiet", "HEAD"])).toBe(
          `refs/heads/${initialBranch}`,
        );
        const service = yield* GitService;
        const removed = yield* service.execute({
          operation: "GitCore.test.deletedAlias",
          cwd,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/safety-alias"],
          allowNonZeroExit: true,
        });
        expect(removed.code).toBe(1);
      }),
    );

    it.effect("keeps a branch when the expected commit looks like a Git option", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* core.createBranch({ cwd, branch: "safety/keep" });
        expect(
          yield* core.deleteBranchIfAt({ cwd, branch: "safety/keep", expectedSha: "--no-deref" }),
        ).toBe(false);
        expect(yield* git(cwd, ["rev-parse", "refs/heads/safety/keep"])).toBe(head);
      }),
    );

    it.effect(
      "rejects option-shaped worktree branch names without changing the checkout or index",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const fileSystem = yield* FileSystem.FileSystem;
          const core = yield* GitCore;
          const indexPath = path.join(cwd, ".git", "index");
          const beforeIndex = yield* fileSystem.readFile(indexPath);
          const beforeBranches = yield* git(cwd, ["branch", "--format=%(refname)"]);
          yield* writeTextFile(path.join(cwd, "README.md"), "keep local edits\n");
          const target = path.join(cwd, "unsafe-worktree");
          for (const newBranch of ["--orphan", "--detach", "--delete", "invalid\0branch"]) {
            const result = yield* Effect.result(
              core.createWorktree({
                cwd,
                branch: initialBranch,
                newBranch,
                path: target,
              }),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.detail).toContain("Invalid worktree ref name");
          }
          expect(yield* fileSystem.exists(target)).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(cwd, "README.md"))).toBe(
            "keep local edits\n",
          );
          expect(yield* fileSystem.readFile(indexPath)).toEqual(beforeIndex);
          expect(yield* git(cwd, ["branch", "--format=%(refname)"])).toBe(beforeBranches);
          expect(yield* git(cwd, ["branch", "--show-current"])).toBe(initialBranch);
        }),
    );

    it.effect(
      "revalidates a generated commit after the workspace coordinator checks out its branch",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          yield* writeTextFile(path.join(cwd, "README.md"), "pending change\n");
          const core = yield* GitCore;
          const context = yield* core.prepareCommitContext(cwd);
          if (!context) throw new Error("Missing commit context");
          yield* core.createBranch({ cwd, branch: "coordinated" });
          yield* Effect.scoped(
            core.checkoutBranch({ cwd, branch: "coordinated" }, { refreshUpstream: false }),
          );
          expect(
            (yield* core.commitPrepared(cwd, "Prepared before switching", "", context)).status,
          ).toBe("created");
          expect(yield* git(cwd, ["branch", "--show-current"])).toBe("coordinated");
        }),
    );
    it.effect("clones into its reserved empty directory using a local bare remote", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const destination = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        const core = yield* GitCore;
        const chunks: Uint8Array[] = [];
        yield* core.cloneRepository({
          cwd: destination,
          url: remote,
          onProgress: (chunk) => chunks.push(chunk),
        });
        expect(yield* git(destination, ["remote", "get-url", "origin"])).toBe(remote);
        expect(yield* git(destination, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
        expect(chunks.length).toBeGreaterThan(0);
      }),
    );
    it.effect("cancelling real git clone can remove its incomplete repository", () =>
      Effect.gen(function* () {
        const destination = yield* makeTmpDir();
        let requested = false;
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<ReturnType<typeof createServer>>((resolve) => {
                const server = createServer(() => {
                  requested = true;
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test server port");
        const core = yield* GitCore;
        const fiber = yield* core
          .cloneRepository({
            cwd: destination,
            url: `http://127.0.0.1:${address.port}/repo.git`,
            onProgress: () => {},
          })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(requested).toBe(true), { timeout: 10_000 }),
        );
        expect(existsSync(path.join(destination, ".git"))).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(existsSync(destination)).toBe(true);
        if (process.platform !== "win32")
          expect(existsSync(path.join(destination, ".git"))).toBe(false);
      }),
    );
    it.effect("does not restore a tracked file when a stale branch name matches it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(path.join(cwd, "README.md"), "unsaved local edits\n");
        const core = yield* GitCore;
        const result = yield* core.checkoutBranch({ cwd, branch: "README.md" }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(path.join(cwd, "README.md"))).toBe("unsaved local edits\n");
      }),
    );

    it.effect("publishes a feature branch without changing its tracked base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-m", "dev"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        const base = yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/dev"]);
        yield* git(cwd, ["checkout", "-b", "feature/safety", "origin/dev"]);
        yield* writeTextFile(path.join(cwd, "change.txt"), "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "feature"]);
        const core = yield* GitCore;
        const result = yield* core.pushCurrentBranch(cwd, null);
        expect(result.upstreamBranch).toBe("origin/feature/safety");
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/dev"])).toBe(base);
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/safety"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        expect(yield* git(cwd, ["config", "--get", "branch.feature/safety.gh-merge-base"])).toBe(
          "dev",
        );
      }),
    );

    it.effect("honors the branch push remote and preserves an explicit merge base", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const publish = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(publish, ["init", "--bare"]);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-m", "dev"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "publish", publish]);
        yield* git(cwd, ["push", "-u", "origin", "dev"]);
        yield* git(cwd, ["checkout", "-b", "feature", "origin/dev"]);
        yield* git(cwd, ["config", "remote.pushDefault", "origin"]);
        yield* git(cwd, ["config", "branch.feature.pushRemote", "publish"]);
        yield* git(cwd, ["config", "branch.feature.gh-merge-base", "release"]);
        yield* writeTextFile(path.join(cwd, "change.txt"), "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "feature"]);
        const core = yield* GitCore;
        expect((yield* core.pushCurrentBranch(cwd, null)).upstreamBranch).toBe("publish/feature");
        expect(yield* git(publish, ["--git-dir=.", "rev-parse", "refs/heads/feature"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        expect(yield* git(cwd, ["config", "--get", "branch.feature.gh-merge-base"])).toBe(
          "release",
        );
      }),
    );

    it.effect("preserves Git's tracking alias for a remote containing a slash", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["branch", "-m", "effect-atom"]);
        yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
        yield* git(cwd, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* git(cwd, [
          "checkout",
          "-b",
          "upstream/effect-atom",
          "--track",
          "my-org/upstream/effect-atom",
        ]);
        yield* writeTextFile(path.join(cwd, "change.txt"), "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "feature"]);
        const core = yield* GitCore;
        const result = yield* core.pushCurrentBranch(cwd, null);
        expect(result.setUpstream).toBe(false);
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/effect-atom"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        expect(
          yield* git(remote, ["--git-dir=.", "branch", "--list", "upstream/effect-atom"]),
        ).toBe("");
      }),
    );

    it.effect("fails a credential-requiring push without waiting for a prompt", () =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = createServer((_request, response) => {
              response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
              response.end();
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test listener");
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["config", "credential.helper", ""]);
        yield* git(cwd, ["config", "core.askPass", ""]);
        yield* git(cwd, ["remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`]);
        const core = yield* GitCore;
        const error = yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.flip, Effect.timeout("5 seconds"));
        expect(error.message).toMatch(/could not authenticate/);
      }),
    );

    it.effect("reads origin HEAD without marking its remote branch as a checkout default", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/stable"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/stable"]);
        const core = yield* GitCore;
        expect(yield* core.readDefaultBranch(cwd)).toBe("stable");
        expect(
          (yield* core.listBranches({ cwd })).branches.find(
            (branch) => branch.name === "origin/stable",
          )?.isDefault,
        ).toBe(false);
      }),
    );

    it.effect("allows a local-only worktree base when a remote exists", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const worktrees = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-b", "local-only"]);
        const core = yield* GitCore;
        expect(
          yield* core.fetchRemoteBranchCommit({
            cwd,
            branch: "local-only",
            allowMissingBranch: true,
          }),
        ).toBeNull();
        const result = yield* core.createWorktree({
          cwd,
          branch: "local-only",
          newBranch: "child",
          path: path.join(worktrees, "child"),
        });
        expect(yield* git(result.worktree.path, ["rev-parse", "HEAD"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    );

    it.effect("reads status with a HEAD file and produces standard patch prefixes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["config", "diff.noprefix", "true"]);
        yield* writeTextFile(path.join(cwd, "HEAD"), "a file, not a ref\n");
        yield* git(cwd, ["add", "HEAD"]);
        const core = yield* GitCore;
        expect((yield* core.statusDetails(cwd)).hasWorkingTreeChanges).toBe(true);
        const context = yield* core.prepareCommitContext(cwd);
        expect(context?.stagedPatch).toContain("diff --git a/HEAD b/HEAD");
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* git(cwd, ["commit", "-m", "add HEAD"]);
        const range = yield* core.readRangeContext(cwd, initialBranch);
        expect(range.diffPatch).toContain("diff --git a/HEAD b/HEAD");
      }),
    );

    it.effect("passive status reads never rewrite the real index after a stat-only change", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const fs = yield* FileSystem.FileSystem;
        const indexPath = path.resolve(cwd, yield* git(cwd, ["rev-parse", "--git-path", "index"]));
        const before = yield* fs.readFile(indexPath);
        const changedTime = new Date(Date.now() + 10000);
        yield* fs.utimes(path.join(cwd, "README.md"), changedTime, changedTime);
        const status = yield* core.statusDetails(cwd);
        expect(status.hasWorkingTreeChanges).toBe(false);
        expect(yield* fs.readFile(indexPath)).toEqual(before);
      }),
    );

    it.effect("background status fetches preserve packs and never start auto-maintenance", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const service = yield* GitService;
        let backgroundTrace = "";
        const core = yield* makeIsolatedGitCore({
          execute: (input) =>
            input.args[0] === "fetch"
              ? service.execute({ ...input, env: { ...input.env, GIT_TRACE: "1" } }).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      backgroundTrace += result.stderr;
                    }),
                  ),
                )
              : service.execute(input),
        });
        const pack = () =>
          Effect.gen(function* () {
            const objects = yield* git(cwd, ["rev-list", "--objects", "--all"]);
            yield* service.execute({
              operation: "test.packObjects",
              cwd,
              args: ["pack-objects", "--", path.join(cwd, ".git", "objects", "pack", "pack")],
              stdin:
                objects
                  .split("\n")
                  .map((line) => line.split(" ")[0])
                  .join("\n") + "\n",
            });
          });
        yield* pack();
        yield* writeTextFile(path.join(cwd, "second.txt"), "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "Second commit"]);
        yield* git(cwd, ["push"]);
        yield* pack();
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        const packs = () =>
          git(cwd, ["count-objects", "-v"]).pipe(
            Effect.map((text) => text.match(/^packs: (\d+)$/m)?.[1]),
          );
        expect(yield* packs()).toBe("2");
        yield* core.statusDetails(cwd);
        expect(yield* packs()).toBe("2");
        expect(backgroundTrace).not.toMatch(/maintenance run --auto/);
        // Positive control: Git's ordinary fetch starts auto-maintenance. Its
        // task policy may leave small packs unchanged on newer Git versions.
        const control = yield* service.execute({
          operation: "test.gcControl",
          cwd,
          args: ["fetch", "--quiet", "origin"],
          env: { GIT_TRACE: "1" },
        });
        expect(control.stderr).toMatch(/maintenance run --auto/);
      }),
    );

    it.effect("reads registered worktrees from an older Git with quoted Unicode paths", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const parent = yield* makeTmpDir();
        const linked = path.join(parent, "café checkout");
        yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["config", "core.quotePath", "true"]);
        yield* git(cwd, ["worktree", "add", "-b", "feature/old-git", linked]);
        const delegate = yield* GitService;
        const oldGit = yield* makeIsolatedGitCore({
          execute: (input) =>
            input.args[0] === "worktree" && input.args.includes("-z")
              ? Effect.succeed({ code: 129, stdout: "", stderr: "error: unknown switch `z'" })
              : delegate.execute(input),
        });
        const fs = yield* FileSystem.FileSystem;
        const listed = (yield* oldGit.listWorktrees(cwd)).find(
          (entry) => entry.branch === "feature/old-git",
        );
        expect(listed?.canonicalPath).toBe(yield* fs.realPath(linked));
        const branch = (yield* oldGit.listBranches({ cwd })).branches.find(
          (entry) => entry.name === "feature/old-git",
        );
        if (!branch?.worktreePath) throw new Error("The registered branch lost its checkout path.");
        expect(yield* fs.realPath(branch.worktreePath)).toBe(yield* fs.realPath(linked));
      }),
    );

    it.effect("reports an index lock and refreshes after release", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const before = yield* core.statusDetails(cwd);
        const fs = yield* FileSystem.FileSystem;
        const index = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
        const lockPath = path.resolve(cwd, index) + ".lock";
        yield* writeTextFile(lockPath, "");
        yield* writeTextFile(path.join(cwd, "README.md"), "changed\n");
        expect(before.hasWorkingTreeChanges).toBe(false);
        expect((yield* core.statusDetails(cwd).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* core.pushCurrentBranch(cwd, null).pipe(Effect.result))._tag).toBe("Failure");
        yield* fs.remove(lockPath);
        expect((yield* core.statusDetails(cwd)).hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect(
      "inspects a clean repository whose index exceeds the buffered output limit",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const fs = yield* FileSystem.FileSystem;
          yield* Effect.forEach(
            Array.from({ length: 15_000 }, (_, i) => i),
            (i) => fs.writeFileString(path.join(cwd, `file-${i}-${"x".repeat(64)}`), "fixture\n"),
            { concurrency: 64 },
          );
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-qm", "large index"]);
          const inspection = yield* (yield* GitCore).inspectCheckout(cwd);
          expect(inspection.hasInitializedSubmodules).toBe(false);
          expect(inspection.hasTrackedChanges).toBe(false);
        }),
      { timeout: 120_000 },
    );

    it.effect("preserves whitespace paths and verifies the exact checkout identity", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        // Windows filenames cannot contain newlines or end in a space.
        const target = path.join(
          cwd,
          process.platform === "win32" ? "linked space ü" : "linked space \n",
        );
        yield* core.createWorktree({
          cwd,
          branch: initialBranch,
          newBranch: "lossless",
          path: target,
        });
        const entry = (yield* core.listWorktrees(cwd)).find((entry) => entry.branch === "lossless");
        expect(entry && path.normalize(entry.path)).toBe(
          yield* (yield* FileSystem.FileSystem).realPath(target),
        );
        expect((yield* core.inspectCheckout(target)).canonicalRoot).toBe(entry?.canonicalPath);
        expect(yield* core.ensureWorktree({ cwd, path: target, branch: "lossless" })).toEqual({
          recreated: false,
        });
        expect(
          (yield* core
            .ensureWorktree({ cwd, path: target, branch: initialBranch })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        const plain = path.join(cwd, "ordinary");
        yield* (yield* FileSystem.FileSystem).makeDirectory(plain);
        expect(
          (yield* core.ensureWorktree({ cwd, path: plain, branch: "lossless" }).pipe(Effect.exit))
            ._tag,
        ).toBe("Failure");
        const other = yield* makeTmpDir();
        yield* initRepoWithCommit(other);
        expect(
          (yield* core
            .ensureWorktree({ cwd: other, path: target, branch: "lossless" })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* core.removeWorktree({ cwd, path: target });
      }),
    );

    it.effect("recreates only managed missing checkouts and refuses ignored secrets", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const core = yield* GitCore;
        const created = yield* core.createWorktree({
          cwd,
          branch: initialBranch,
          newBranch: "recreate-safe",
          path: null,
        });
        const target = created.worktree.path;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(target, { recursive: true });
        expect(
          yield* core.ensureWorktree({
            cwd,
            path: target,
            branch: "recreate-safe",
            submodules: "none",
          }),
        ).toEqual({ recreated: true });
        yield* writeTextFile(path.join(cwd, ".git", "info", "exclude"), ".env\nnode_modules/\n");
        yield* writeTextFile(path.join(target, ".env"), "LOCAL=secret\n");
        expect(
          (yield* core.removeWorktree({ cwd, path: target, force: true }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* fs.exists(path.join(target, ".env"))).toBe(true);
        yield* fs.remove(path.join(target, ".env"));
        yield* core.removeWorktree({ cwd, path: target });
        expect(
          (yield* core
            .ensureWorktree({
              cwd,
              path: path.join(cwd, "outside-managed"),
              branch: "recreate-safe",
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    );

    it.effect("removes only the registration of an already missing worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const root = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const target = path.join(root, "missing");
        yield* git(cwd, ["worktree", "add", "-b", "disappeared", target]);
        const fs = yield* FileSystem.FileSystem;
        const unrelated = path.join(root, "offline");
        yield* git(cwd, ["worktree", "add", "-b", "offline", unrelated]);
        yield* fs.remove(unrelated, { recursive: true });
        yield* fs.remove(target, { recursive: true });
        const core = yield* GitCore;
        yield* core.removeWorktree({ cwd, path: path.join(root, "never-registered") });
        const registeredPaths = () =>
          git(cwd, ["worktree", "list", "--porcelain", "-z"]).pipe(
            Effect.map((output) =>
              parseWorktreeListPorcelain(output).map((entry) => path.normalize(entry.path)),
            ),
          );
        expect(yield* registeredPaths()).toContain(target);
        yield* core.removeWorktree({ cwd, path: target });
        expect(yield* registeredPaths()).toContain(unrelated);
        expect(yield* registeredPaths()).not.toContain(target);
      }),
    );
  });

  describe("shell process execution", () => {
    it.effect("caps captured output when maxOutputBytes is exceeded", () =>
      Effect.gen(function* () {
        const result = yield* runShellCommand({
          command: `echo ${"x".repeat(2000)}`,
          cwd: process.cwd(),
          timeoutMs: 10_000,
          maxOutputBytes: 128,
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toBe("x".repeat(128));
        expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
      }),
    );
  });

  describe("readRangeContext", () => {
    it.effect("uses the remote-tracking merge base for PR diff content", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir("git-range-remote-");
        const repo = yield* makeTmpDir("git-range-repo-");
        yield* git(remote, ["init", "--bare"]);
        const { initialBranch } = yield* initRepoWithCommit(repo);
        const initialCommit = yield* git(repo, ["rev-parse", "HEAD"]);
        yield* git(repo, ["remote", "add", "origin", remote]);
        yield* git(repo, ["push", "-u", "origin", initialBranch]);

        yield* writeTextFile(path.join(repo, "shared-base.txt"), "shared base\n");
        yield* git(repo, ["add", "shared-base.txt"]);
        yield* git(repo, ["commit", "-m", "shared base"]);
        yield* git(repo, ["push", "origin", initialBranch]);

        yield* git(repo, ["checkout", "-b", "feature", `origin/${initialBranch}`]);
        yield* writeTextFile(path.join(repo, "feature.txt"), "feature change\n");
        yield* git(repo, ["add", "feature.txt"]);
        yield* git(repo, ["commit", "-m", "feature change"]);

        yield* git(repo, ["checkout", initialBranch]);
        yield* git(repo, ["reset", "--hard", `origin/${initialBranch}`]);
        yield* writeTextFile(path.join(repo, "base-only.txt"), "base moved\n");
        yield* git(repo, ["add", "base-only.txt"]);
        yield* git(repo, ["commit", "-m", "move base"]);
        yield* git(repo, ["push", "origin", initialBranch]);
        yield* git(repo, ["reset", "--hard", initialCommit]);
        yield* git(repo, ["checkout", "feature"]);

        const expected = yield* git(repo, [
          "diff",
          "--patch",
          "--minimal",
          `origin/${initialBranch}...HEAD`,
        ]);
        const incorrectTwoDot = yield* git(repo, [
          "diff",
          "--patch",
          "--minimal",
          `origin/${initialBranch}..HEAD`,
        ]);
        const incorrectStaleLocal = yield* git(repo, [
          "diff",
          "--patch",
          "--minimal",
          `${initialBranch}...HEAD`,
        ]);

        const core = yield* GitCore;
        const context = yield* core.readRangeContext(repo, initialBranch);
        expect(context.diffPatch.trim()).toBe(expected);
        expect(context.diffPatch.trim()).not.toBe(incorrectTwoDot);
        expect(context.diffPatch.trim()).not.toBe(incorrectStaleLocal);
        expect(context.diffPatch).toContain("feature.txt");
        expect(context.diffPatch).not.toContain("base-only.txt");
      }),
    );
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it.effect("creates a valid git repo", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initGitRepo({ cwd: tmp });
        expect(existsSync(path.join(tmp, ".git"))).toBe(true);
      }),
    );

    it.effect("listGitBranches reports isRepo: true after init + commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.isRepo).toBe(true);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it.effect("returns isRepo: false for non-git directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.isRepo).toBe(false);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("returns the current branch with current: true", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current).toBeDefined();
        expect(current!.current).toBe(true);
      }),
    );

    it.effect("does not include detached HEAD pseudo-refs as branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["checkout", "--detach", "HEAD"]);

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.some((branch) => branch.name.startsWith("("))).toBe(false);
        expect(result.branches.some((branch) => branch.current)).toBe(false);
      }),
    );

    it.effect("keeps current branch first and sorts the remaining branches by recency", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* createGitBranch({ cwd: tmp, branch: "older-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "older-branch" });
        yield* commitWithDate(
          tmp,
          "older.txt",
          "older branch change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "older branch change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: initialBranch });
        yield* createGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer branch change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer branch change",
        );

        // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
        yield* checkoutGitBranch({ cwd: tmp, branch: "older-branch" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("older-branch");
        expect(result.branches[1]!.name).toBe("newer-branch");
      }),
    );

    it.effect("keeps default branch right after current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);
        yield* git(tmp, ["remote", "set-head", "origin", defaultBranch]);

        yield* createGitBranch({ cwd: tmp, branch: "current-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "current-branch" });
        yield* commitWithDate(
          tmp,
          "current.txt",
          "current change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "current change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: defaultBranch });
        yield* createGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer change",
        );

        yield* checkoutGitBranch({ cwd: tmp, branch: "current-branch" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("current-branch");
        expect(result.branches[1]!.name).toBe(defaultBranch);
        expect(result.branches[2]!.name).toBe("newer-branch");
      }),
    );

    it.effect("lists multiple branches after creating them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature-a" });
        yield* createGitBranch({ cwd: tmp, branch: "feature-b" });

        const result = yield* listGitBranches({ cwd: tmp });
        const names = result.branches.map((b) => b.name);
        expect(names).toContain("feature-a");
        expect(names).toContain("feature-b");
      }),
    );

    it.effect("isDefault is false when no remote exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
      }),
    );

    it.effect("lists local branches first and remote branches last", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);

        yield* createGitBranch({ cwd: tmp, branch: "feature/local-only" });

        const remoteOnlyBranch = "feature/remote-only";
        yield* checkoutGitBranch({ cwd: tmp, branch: defaultBranch });
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", "origin", remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* listGitBranches({ cwd: tmp });
        const firstRemoteIndex = result.branches.findIndex((branch) => branch.isRemote);

        expect(result.hasOriginRemote).toBe(true);
        expect(firstRemoteIndex).toBeGreaterThan(0);
        expect(result.branches.slice(0, firstRemoteIndex).every((branch) => !branch.isRemote)).toBe(
          true,
        );
        expect(result.branches.slice(firstRemoteIndex).every((branch) => branch.isRemote)).toBe(
          true,
        );
        expect(
          result.branches.some(
            (branch) => branch.name === "feature/local-only" && !branch.isRemote,
          ),
        ).toBe(true);
        expect(
          result.branches.some(
            (branch) => branch.name === "origin/feature/remote-only" && branch.isRemote,
          ),
        ).toBe(true);
      }),
    );

    it.effect("includes remoteName metadata for remotes with slash in the name", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const remoteName = "my-org/upstream";

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", remoteName, remote]);
        yield* git(tmp, ["push", "-u", remoteName, defaultBranch]);

        const remoteOnlyBranch = "feature/remote-with-remote-name";
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", remoteName, remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* listGitBranches({ cwd: tmp });
        const remoteBranch = result.branches.find(
          (branch) => branch.name === `${remoteName}/${remoteOnlyBranch}`,
        );

        expect(remoteBranch).toBeDefined();
        expect(remoteBranch?.isRemote).toBe(true);
        expect(remoteBranch?.remoteName).toBe(remoteName);
      }),
    );
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature" });

        yield* checkoutGitBranch({ cwd: tmp, branch: "feature" });

        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* createGitBranch({ cwd: source, branch: featureBranch });
        yield* checkoutGitBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* checkoutGitBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* checkoutGitBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const details = await Effect.runPromise(core.statusDetails(source));
              expect(details.branch).toBe(featureBranch);
              expect(details.aheadCount).toBe(0);
              expect(details.behindCount).toBe(1);
            },
            { timeout: 10_000 },
          ),
        );
      }),
    );

    it.effect("does not hold the repository lock while a status refresh waits on the network", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir(),
          source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const branch = (yield* git(source, ["branch", "--show-current"])).trim();
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", branch]);
        yield* git(source, ["branch", "local-while-fetching"]);
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const realGitService = yield* GitService;
        const core = yield* makeIsolatedGitCore({
          execute: (input) =>
            input.args[0] === "fetch"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ code: 128, stdout: "", stderr: "offline" }),
                )
              : realGitService.execute(input),
        });
        yield* core.statusDetails(source);
        yield* Deferred.await(entered);
        yield* core
          .checkoutBranch({ cwd: source, branch: "local-while-fetching" })
          .pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        expect((yield* git(source, ["branch", "--show-current"])).trim()).toBe(
          "local-while-fetching",
        );
      }),
    );

    it.effect("keeps user pull refs and FETCH_HEAD when a delayed status fetch finishes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir(),
          source = yield* makeTmpDir(),
          clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const branch = (yield* git(source, ["branch", "--show-current"])).trim();
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", branch]);
        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", branch]);
        yield* writeTextFile(path.join(clone, "new.txt"), "first update");
        yield* git(clone, ["add", "new.txt"]);
        yield* git(clone, ["commit", "-m", "first update"]);
        yield* git(clone, ["push", "origin", branch]);
        const fetched = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const realGitService = yield* GitService;
        const core = yield* makeIsolatedGitCore({
          execute: (input) =>
            realGitService
              .execute(input)
              .pipe(
                Effect.tap(() =>
                  input.args[0] === "fetch"
                    ? Deferred.succeed(fetched, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
                ),
              ),
        });
        yield* core.statusDetails(source);
        yield* Deferred.await(fetched);
        yield* Effect.gen(function* () {
          yield* writeTextFile(path.join(clone, "new.txt"), "newer update");
          yield* git(clone, ["add", "new.txt"]);
          yield* git(clone, ["commit", "-m", "newer update"]);
          yield* git(clone, ["push", "origin", branch]);
          yield* git(source, ["pull", "--ff-only"]);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* core.drainUpstreamRefreshes!(source);
        const head = (yield* git(source, ["rev-parse", "HEAD"])).trim();
        expect((yield* git(source, ["rev-parse", `refs/remotes/origin/${branch}`])).trim()).toBe(
          head,
        );
        expect((yield* git(source, ["rev-parse", "FETCH_HEAD"])).trim()).toBe(head);
        expect((yield* git(source, ["for-each-ref", "refs/f5/status"])).trim()).toBe("");
      }),
    );

    it.effect("falls back on older Git, promotes tracking refs and warns once", () => {
      const messages: string[] = [];
      return Effect.gen(function* () {
        const remote = yield* makeTmpDir(),
          source = yield* makeTmpDir(),
          other = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const branch = (yield* git(source, ["branch", "--show-current"])).trim();
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", branch]);
        yield* git(other, ["clone", source, "."]);
        yield* writeTextFile(path.join(source, "legacy-refresh.txt"), "new upstream commit");
        yield* git(source, ["add", "legacy-refresh.txt"]);
        yield* git(source, ["commit", "-m", "legacy refresh update"]);
        yield* git(source, ["push", "origin", branch]);
        const expected = (yield* git(source, ["rev-parse", "HEAD"])).trim();
        const realGitService = yield* GitService;
        let fetches = 0,
          legacyFetches = 0;
        const core = yield* makeIsolatedGitCore({
          execute: (input) =>
            Effect.suspend(() => {
              if (input.args[0] !== "fetch") return realGitService.execute(input);
              fetches++;
              if (input.args.includes("--no-write-fetch-head"))
                return Effect.succeed({
                  code: 129,
                  stdout: "",
                  stderr: "error: unknown option no-write-fetch-head",
                });
              legacyFetches++;
              return realGitService.execute(input);
            }),
        });
        for (const cwd of [source, other]) {
          yield* core.statusDetails(cwd);
          yield* core.drainUpstreamRefreshes!(cwd);
        }
        expect(fetches).toBe(3);
        expect(legacyFetches).toBe(2);
        expect((yield* git(other, ["rev-parse", `refs/remotes/origin/${branch}`])).trim()).toBe(
          expected,
        );
        for (const cwd of [source, other])
          expect((yield* git(cwd, ["for-each-ref", "refs/f5/status/"])).trim()).toBe("");
        expect(
          messages.filter((message) => message.includes("using compatibility mode")),
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(
          Logger.layer(
            [
              Logger.make((entry) => {
                messages.push(String(entry.message));
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
    });

    it.effect("sweeps abandoned status refs without deleting another live profile's refs", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir(),
          source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const branch = (yield* git(source, ["branch", "--show-current"])).trim();
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", branch]);
        const stale = `refs/f5/status/${Date.now() - 31 * 60_000}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
        const live = `refs/f5/status/${Date.now()}-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
        const legacy = "refs/f5/status/cccccccc-cccc-cccc-cccc-cccccccccccc";
        for (const ref of [stale, live, legacy]) yield* git(source, ["update-ref", ref, "HEAD"]);
        const core = yield* makeIsolatedGitCore(yield* GitService);
        yield* core.statusDetails(source);
        yield* core.drainUpstreamRefreshes!(source);
        const refs = (yield* git(source, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/f5/status/",
        ])).split("\n");
        expect(refs).toEqual([live, legacy].sort());
      }),
    );

    it.effect("keeps checkout successful when upstream refresh fails", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-refresh-failure";
        yield* git(source, ["branch", featureBranch]);
        yield* git(source, ["checkout", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        let refreshFetchAttempts = 0;
        const refreshAttempted = yield* Deferred.make<void>();
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              refreshFetchAttempts += 1;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.refreshFailure",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "simulated fetch timeout",
                }),
              ).pipe(Effect.ensuring(Deferred.succeed(refreshAttempted, undefined)));
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        // Checkout intentionally forks refresh. Synchronize with that work
        // rather than requiring a loaded CI host to admit it within one second.
        yield* Deferred.await(refreshAttempted);
        expect(refreshFetchAttempts).toBe(1);
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
      }),
    );

    it.effect("briefly caches failed upstream refreshes across repeated status checks", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-refresh-cache";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);

        const realGitService = yield* GitService;
        let refreshFetchAttempts = 0;
        const refreshAttempted = yield* Deferred.make<void>();
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              refreshFetchAttempts += 1;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.refreshFailureCache",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "simulated fetch timeout",
                }),
              ).pipe(Effect.ensuring(Deferred.succeed(refreshAttempted, undefined)));
            }
            return realGitService.execute(input);
          },
        });

        const first = yield* core.statusDetails(source);
        yield* Deferred.await(refreshAttempted);
        const second = yield* core.statusDetails(source);

        expect(first.branch).toBe(featureBranch);
        expect(second.branch).toBe(featureBranch);
        expect(refreshFetchAttempts).toBe(1);
      }),
    );

    it.effect("local-only status checks never fetch the upstream", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const realGitService = yield* GitService;
        let fetches = 0;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") fetches += 1;
            return realGitService.execute(input);
          },
        });

        const local = yield* core.statusDetails(source, { refreshUpstream: false });
        expect(local.branch).toBe(defaultBranch);
        expect(fetches).toBe(0);
        yield* core.statusDetails(source);
        // The upstream refresh runs in the background.
        yield* core.drainUpstreamRefreshes!(source);
        expect(fetches).toBe(1);
      }),
    );

    it.effect("refresh fetch is scoped to the checked out branch upstream refspec", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/scoped-fetch";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        let fetchArgs: readonly string[] | null = null;
        const fetchAdmitted = yield* Deferred.make<void>();
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              fetchArgs = [...input.args];
              return Deferred.succeed(fetchAdmitted, undefined).pipe(
                Effect.andThen(realGitService.execute(input)),
              );
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Deferred.await(fetchAdmitted);

        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        expect(fetchArgs).toEqual([
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-auto-maintenance",
          "--refmap=",
          "--",
          "origin",
          expect.stringMatching(new RegExp(`^\\+refs/heads/${featureBranch}:refs/f5/status/`)),
        ]);
      }),
    );

    it.effect("returns checkout result before background upstream refresh completes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/background-refresh";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitService = yield* GitService;
        const fetchAdmitted = yield* Deferred.make<void>();
        let releaseFetch!: () => void;
        const waitForReleasePromise = new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "fetch") {
              Effect.runSync(Deferred.succeed(fetchAdmitted, undefined));
              return Effect.promise(() =>
                waitForReleasePromise.then(() => ({ code: 0, stdout: "", stderr: "" })),
              );
            }
            return realGitService.execute(input);
          },
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Deferred.await(fetchAdmitted);
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
        releaseFetch();
      }),
    );

    it.effect(
      "returns local status during a hanging refresh and invalidates only after real refresh",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          const featureBranch = "feature/background-refresh";
          yield* git(source, ["checkout", "-b", featureBranch]);
          yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature base"]);
          yield* git(source, ["push", "-u", "origin", featureBranch]);

          const realGitService = yield* GitService;
          const fetchAdmitted = yield* Deferred.make<void>();
          let releaseFetch!: () => void;
          const waitForReleasePromise = new Promise<void>((resolve) => {
            releaseFetch = resolve;
          });
          const core = yield* makeIsolatedGitCore({
            execute: (input) => {
              if (input.args[0] === "fetch") {
                Effect.runSync(Deferred.succeed(fetchAdmitted, undefined));
                return Effect.promise(() => waitForReleasePromise).pipe(
                  Effect.andThen(realGitService.execute(input)),
                );
              }
              return realGitService.execute(input);
            },
          });
          const invalidations: string[] = [];
          const refreshed = yield* Deferred.make<void>();
          yield* core.subscribeStatusRefresh!((cwd) => {
            invalidations.push(cwd);
            Effect.runSync(Deferred.succeed(refreshed, undefined));
          });
          const first = yield* core.statusDetails(source);
          expect(first.branch).toBe(featureBranch);
          yield* Deferred.await(fetchAdmitted);
          const second = yield* core.statusDetails(source);
          expect(second.branch).toBe(featureBranch);
          expect(invalidations).toEqual([]);
          releaseFetch();
          yield* Deferred.await(refreshed);
          yield* core.statusDetails(source);
          yield* Effect.yieldNow;
          expect(invalidations).toEqual([source]);
        }),
    );

    it.effect("throws when branch does not exist", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(checkoutGitBranch({ cwd: tmp, branch: "nonexistent" }));
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("does not silently checkout a local branch when a remote ref no longer exists", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        yield* createGitBranch({ cwd: source, branch: "feature" });

        const checkoutResult = yield* Effect.result(
          checkoutGitBranch({ cwd: source, branch: "origin/feature" }),
        );
        expect(checkoutResult._tag).toBe("Failure");
        expect(yield* git(source, ["branch", "--show-current"])).toBe(defaultBranch);
      }),
    );

    it.effect("checks out a remote tracking branch when remote name contains slashes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const remoteName = "my-org/upstream";
        const featureBranch = "feature";
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", remoteName, remote]);
        yield* git(source, ["push", "-u", remoteName, defaultBranch]);

        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature content\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature commit"]);
        yield* git(source, ["push", "-u", remoteName, featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);
        yield* git(source, ["branch", "-D", featureBranch]);

        yield* checkoutGitBranch({ cwd: source, branch: `${remoteName}/${featureBranch}` });

        expect(yield* git(source, ["branch", "--show-current"])).toBe("upstream/feature");
      }),
    );

    it.effect(
      "falls back to detached checkout when --track would conflict with an existing local branch",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* listGitBranches({ cwd: source })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          // Keep local branch but remove tracking so `--track origin/<branch>`
          // would attempt to create an already-existing local branch.
          yield* git(source, ["branch", "--unset-upstream"]);

          yield* checkoutGitBranch({ cwd: source, branch: `origin/${defaultBranch}` });

          const core = yield* GitCore;
          const status = yield* core.statusDetails(source);
          expect(status.branch).toBeNull();
        }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "other" });

        // Create a conflicting change: modify README on current branch
        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        // First, checkout other branch cleanly
        yield* git(tmp, ["stash"]);
        yield* checkoutGitBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        // Go back to default branch
        const defaultBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* checkoutGitBranch({ cwd: tmp, branch: defaultBranch });

        // Make uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        // Checkout should fail due to uncommitted changes
        const result = yield* Effect.result(checkoutGitBranch({ cwd: tmp, branch: "other" }));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it.effect("creates a new branch visible in listGitBranches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(createGitBranch({ cwd: tmp, branch: "dupe" }));
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── renameGitBranch ──

  describe("renameGitBranch", () => {
    it.effect("renames the current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature/old-name" });

        const renamed = yield* renameGitBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");

        const branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/old-name")).toBe(false);
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("feature/new-name");
      }),
    );

    it.effect("returns success without git invocation when old/new names match", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const current = (yield* listGitBranches({ cwd: tmp })).branches.find((b) => b.current)!;

        const renamed = yield* renameGitBranch({
          cwd: tmp,
          oldBranch: current.name,
          newBranch: current.name,
        });

        expect(renamed.branch).toBe(current.name);
      }),
    );

    it.effect("appends numeric suffix when target branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* createGitBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* renameGitBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-1");
        const branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session")).toBe(
          true,
        );
        expect(branches.branches.some((branch) => branch.name === "t3code/feat/session-1")).toBe(
          true,
        );
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("t3code/feat/session-1");
      }),
    );

    it.effect("increments suffix until it finds an available branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "t3code/feat/session" });
        yield* createGitBranch({ cwd: tmp, branch: "t3code/feat/session-1" });
        yield* createGitBranch({ cwd: tmp, branch: "t3code/tmp-working" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "t3code/tmp-working" });

        const renamed = yield* renameGitBranch({
          cwd: tmp,
          oldBranch: "t3code/tmp-working",
          newBranch: "t3code/feat/session",
        });

        expect(renamed.branch).toBe("t3code/feat/session-2");
      }),
    );

    it.effect("uses '--' separator for branch rename arguments", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature/old-name" });

        const realGitService = yield* GitService;
        let renameArgs: ReadonlyArray<string> | null = null;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args[0] === "branch" && input.args[1] === "-m") {
              renameArgs = [...input.args];
            }
            return realGitService.execute(input);
          },
        });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");
        expect(renameArgs).toEqual(["branch", "-m", "--", "feature/old-name", "feature/new-name"]);
      }),
    );
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it.effect("creates a worktree from the freshly fetched origin commit", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const peer = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        const { initialBranch } = yield* initRepoWithCommit(source);
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);
        const staleLocalCommit = yield* git(source, ["rev-parse", "HEAD"]);

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(peer, "origin-only.txt"), "from origin\n");
        yield* git(peer, ["add", "origin-only.txt"]);
        yield* git(peer, ["commit", "-m", "advance origin"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const originCommit = yield* git(peer, ["rev-parse", "HEAD"]);

        const core = yield* GitCore;
        const resolved = yield* core.fetchRemoteBranchCommit({
          cwd: source,
          branch: initialBranch,
        });
        expect(resolved).toMatchObject({
          remoteName: "origin",
          branch: initialBranch,
          refName: `origin/${initialBranch}`,
          commit: originCommit,
        });

        const wtPath = path.join(source, "origin-based-worktree");
        yield* core.createWorktree({
          cwd: source,
          branch: initialBranch,
          baseRefName: resolved!.commit,
          newBranch: "feature/origin-based",
          path: wtPath,
        });

        expect(yield* git(wtPath, ["rev-parse", "HEAD"])).toBe(originCommit);
        expect(yield* git(source, ["rev-parse", initialBranch])).toBe(staleLocalCommit);
        expect(existsSync(path.join(wtPath, "origin-only.txt"))).toBe(true);

        yield* core.removeWorktree({ cwd: source, path: wtPath });
      }),
    );

    it.effect("fetches the origin base when invoked from a linked worktree cwd", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const peer = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        const { initialBranch } = yield* initRepoWithCommit(source);
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        const linkedPath = path.join(source, "linked-cwd");
        const core = yield* GitCore;
        yield* core.createWorktree({
          cwd: source,
          branch: initialBranch,
          newBranch: "feature/linked-cwd",
          path: linkedPath,
        });

        yield* git(peer, ["clone", remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(peer, "remote-update.txt"), "updated\n");
        yield* git(peer, ["add", "remote-update.txt"]);
        yield* git(peer, ["commit", "-m", "remote update"]);
        yield* git(peer, ["push", "origin", initialBranch]);
        const originCommit = yield* git(peer, ["rev-parse", "HEAD"]);

        const resolved = yield* core.fetchRemoteBranchCommit({
          cwd: linkedPath,
          branch: initialBranch,
        });
        expect(resolved!.commit).toBe(originCommit);
        expect(yield* git(linkedPath, ["rev-parse", `origin/${initialBranch}`])).toBe(originCommit);

        yield* core.removeWorktree({ cwd: source, path: linkedPath });
      }),
    );

    it.effect("returns a typed git error when the origin base branch is missing", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(source);
        yield* git(source, ["remote", "add", "origin", remote]);

        const core = yield* GitCore;
        const result = yield* Effect.result(
          core.fetchRemoteBranchCommit({ cwd: source, branch: "missing-base" }),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(GitCommandError);
          expect(result.failure.operation).toBe("GitCore.fetchRemoteBranchCommit.fetch");
        }
      }),
    );

    it.effect("creates a worktree with a new branch from the base branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "worktree-out");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-branch",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("wt-branch");
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

        // Clean up worktree before tmp dir disposal
        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        // Verify the worktree is on the new branch
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("creates a worktree for an existing branch when newBranch is omitted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature/existing-worktree" });

        const wtPath = path.join(tmp, "wt-existing");
        const result = yield* createGitWorktree({
          cwd: tmp,
          branch: "feature/existing-worktree",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("feature/existing-worktree");
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("feature/existing-worktree");

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          createGitWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "existing",
            path: wtPath,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("listGitBranches from worktree cwd reports worktree branch as current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-list-dir");
        const mainBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        // listGitBranches from the worktree should show wt-list as current
        const wtBranches = yield* listGitBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        // Main repo should still show the original branch as current
        const mainBranches = yield* listGitBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect(
      "refuses dirty worktree removal even through the internal compatibility force input",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);

          const wtPath = path.join(tmp, "wt-dirty-dir");
          const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
            (b) => b.current,
          )!.name;

          yield* createGitWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "wt-dirty",
            path: wtPath,
          });
          expect(existsSync(wtPath)).toBe(true);

          yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

          const failedRemove = yield* Effect.result(removeGitWorktree({ cwd: tmp, path: wtPath }));
          expect(failedRemove._tag).toBe("Failure");
          expect(existsSync(wtPath)).toBe(true);

          expect(
            (yield* Effect.result(removeGitWorktree({ cwd: tmp, path: wtPath, force: true })))._tag,
          ).toBe("Failure");
          expect(existsSync(wtPath)).toBe(true);
        }),
    );
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it.effect("init → commit → create branch → checkout → verify current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "feature-login" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* listGitBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature-login");
      }),
    );
  });

  // ── Full flow: worktree creation from base branch ──

  describe("full flow: worktree creation", () => {
    it.effect("creates worktree with new branch from current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const currentBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* createGitWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        // Worktree exists
        expect(existsSync(result.worktree.path)).toBe(true);

        // Main repo still on original branch
        const mainBranches = yield* listGitBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        // Worktree is on the new branch
        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* removeGitWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });

  describe("fetchPullRequestBranch", () => {
    it.effect(
      "treats an option-shaped configured remote as a name, without running its upload-pack payload",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const remote = yield* makeTmpDir("git-option-remote-");
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, [
            "push",
            "--",
            remote,
            `HEAD:refs/heads/${initialBranch}`,
            "HEAD:refs/pull/7/head",
          ]);
          const remoteName = "--upload-pack=touch${IFS}f5-option-marker;false";
          yield* git(cwd, ["config", "--", `remote.${remoteName}.url`, remote]);
          const core = yield* GitCore;
          yield* core.fetchRemoteBranch({
            cwd,
            remoteName,
            remoteBranch: initialBranch,
            localBranch: "safe-tracking",
          });
          yield* core.fetchPullRequestBranch({ cwd, prNumber: 7, branch: "safe-pr" });
          expect(existsSync(path.join(cwd, "f5-option-marker"))).toBe(false);
          expect(yield* git(cwd, ["rev-parse", "safe-tracking"])).toBe(
            yield* git(cwd, ["rev-parse", "HEAD"]),
          );
          expect(yield* git(cwd, ["rev-parse", "safe-pr"])).toBe(
            yield* git(cwd, ["rev-parse", "HEAD"]),
          );
        }),
    );

    it.effect("fetches a GitHub pull request ref into a local branch without checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteDir = yield* makeTmpDir("git-remote-");
        yield* git(remoteDir, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remoteDir]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "feature/pr-fetch"]);
        yield* writeTextFile(path.join(tmp, "pr-fetch.txt"), "fetch me\n");
        yield* git(tmp, ["add", "pr-fetch.txt"]);
        yield* git(tmp, ["commit", "-m", "Add PR fetch branch"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/pr-fetch"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/pull/55/head"]);
        yield* git(tmp, ["checkout", initialBranch]);

        yield* fetchGitPullRequestBranch({
          cwd: tmp,
          prNumber: 55,
          branch: "feature/pr-fetch",
        });

        const localBranches = yield* git(tmp, ["branch", "--list", "feature/pr-fetch"]);
        expect(localBranches).toContain("feature/pr-fetch");
        const currentBranch = yield* git(tmp, ["branch", "--show-current"]);
        expect(currentBranch).toBe(initialBranch);
      }),
    );
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "branch-a" });
        yield* createGitBranch({ cwd: tmp, branch: "branch-b" });

        // Simulate switching to thread A's branch
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        // Simulate switching to thread B's branch
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        // Switch back to thread A
        yield* checkoutGitBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* listGitBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
      }),
    );
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it.effect("prepares a temporary recovery branch from origin/x without an upstream", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const recovery = path.join(yield* makeTmpDir(), "recovery");
        const core = yield* GitCore;
        yield* initRepoWithCommit(repo);
        yield* git(remote, ["init", "--bare"]);
        yield* git(repo, ["remote", "add", "origin", remote]);
        yield* git(repo, ["push", "origin", "HEAD:refs/heads/x"]);
        yield* git(repo, ["fetch", "origin"]);
        const commit = yield* core.resolveCommit(repo, "origin/x");
        expect(commit).not.toBeNull();
        yield* core.createWorktree({
          cwd: repo,
          branch: "origin/x",
          baseRefName: commit!,
          newBranch: "t3code/12345678",
          path: recovery,
        });
        expect(yield* git(recovery, ["rev-parse", "HEAD"])).toBe(commit);
        expect(yield* git(recovery, ["branch", "--show-current"])).toBe("t3code/12345678");
        expect(yield* core.readConfigValue(recovery, "branch.t3code/12345678.remote")).toBeNull();
        expect(yield* core.readConfigValue(recovery, "branch.t3code/12345678.merge")).toBeNull();
      }),
    );

    it.effect(
      "returns the conflicting files and preserves staged, unstaged and untracked work",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const core = yield* GitCore;
          yield* initRepoWithCommit(tmp);
          const initialBranch = yield* git(tmp, ["branch", "--show-current"]);
          yield* git(tmp, ["checkout", "-b", "target"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "target readme\n");
          yield* writeTextFile(path.join(tmp, "new file.txt"), "tracked on target\n");
          yield* git(tmp, ["add", "README.md", "new file.txt"]);
          yield* git(tmp, ["commit", "-m", "target files"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* writeTextFile(path.join(tmp, "README.md"), "staged readme\n");
          yield* git(tmp, ["add", "README.md"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "unstaged readme\n");
          yield* writeTextFile(path.join(tmp, "new file.txt"), "untracked work\n");
          const before = yield* git(tmp, ["status", "--porcelain=v1"]);
          const result = yield* Effect.result(core.checkoutBranch({ cwd: tmp, branch: "target" }));
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure.checkoutConflict).toEqual({
            cwd: tmp,
            branch: "target",
            files: ["README.md", "new file.txt"],
          });
          expect(yield* git(tmp, ["branch", "--show-current"])).toBe(initialBranch);
          expect(yield* git(tmp, ["status", "--porcelain=v1"])).toBe(before);
          expect(yield* git(tmp, ["show", ":README.md"])).toBe("staged readme");
          expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe(
            "unstaged readme\n",
          );
          expect(yield* fileSystem.readFileString(path.join(tmp, "new file.txt"))).toBe(
            "untracked work\n",
          );
          const recoveryPath = path.join(yield* makeTmpDir(), "recovery");
          yield* core.createWorktree({
            cwd: tmp,
            branch: "target",
            newBranch: "recovery",
            path: recoveryPath,
          });
          expect(yield* git(recoveryPath, ["branch", "--show-current"])).toBe("recovery");
          expect(yield* fileSystem.readFileString(path.join(recoveryPath, "README.md"))).toBe(
            "target readme\n",
          );
          expect(yield* git(tmp, ["status", "--porcelain=v1"])).toBe(before);
          expect(yield* git(tmp, ["show", ":README.md"])).toBe("staged readme");
          expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe(
            "unstaged readme\n",
          );
          expect(yield* fileSystem.readFileString(path.join(tmp, "new file.txt"))).toBe(
            "untracked work\n",
          );
        }),
    );

    it.effect(
      "switches a worktree to the default branch without changing a dirty main checkout",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const wt = path.join(yield* makeTmpDir(), "worktree");
          const core = yield* GitCore;
          yield* initRepoWithCommit(tmp);
          const defaultBranch = yield* git(tmp, ["branch", "--show-current"]);
          yield* git(tmp, ["checkout", "-b", "composer"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "composer commit\n");
          yield* git(tmp, ["add", "README.md"]);
          yield* git(tmp, ["commit", "-m", "composer base"]);
          yield* core.createWorktree({
            cwd: tmp,
            branch: defaultBranch,
            newBranch: "thread",
            path: wt,
          });
          yield* writeTextFile(path.join(tmp, "README.md"), "staged composer\n");
          yield* git(tmp, ["add", "README.md"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "unstaged composer\n");
          const beforeIndex = yield* git(tmp, ["diff", "--cached"]);
          const beforeWorkingTree = yield* git(tmp, ["diff"]);
          yield* core.checkoutBranch({ cwd: wt, branch: defaultBranch });
          expect(yield* git(wt, ["branch", "--show-current"])).toBe(defaultBranch);
          expect(yield* git(tmp, ["branch", "--show-current"])).toBe("composer");
          expect(yield* git(tmp, ["diff", "--cached"])).toBe(beforeIndex);
          expect(yield* git(tmp, ["diff"])).toBe(beforeWorkingTree);
        }),
    );

    it.effect("uncommitted changes prevent checkout to a diverged branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* createGitBranch({ cwd: tmp, branch: "diverged" });

        // Make diverged branch have different file content
        yield* checkoutGitBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        // Actually, let's just get back to the initial branch explicitly
        const allBranches = yield* listGitBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* checkoutGitBranch({ cwd: tmp, branch: initialBranch });

        // Make local uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        // Attempt checkout should fail
        const failedCheckout = yield* Effect.result(
          checkoutGitBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        // Current branch should still be the initial one
        const result = yield* listGitBranches({ cwd: tmp });
        expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
      }),
    );
  });

  describe("GitCore", () => {
    it.effect(
      "inspects inventory dirtiness without fetching and returns null for non-checkouts",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;
          expect(yield* core.isDirty(tmp)).toBe(false);
          yield* writeTextFile(path.join(tmp, "untracked file "), "contents");
          expect(yield* core.isDirty(tmp)).toBe(true);
          const nonRepo = yield* makeTmpDir();
          expect(yield* core.isDirty(nonRepo)).toBeNull();
        }),
    );

    it.effect("supports branch lifecycle operations through the service API", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;

        yield* core.initRepo({ cwd: tmp });
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "initial commit"]);

        yield* core.createBranch({ cwd: tmp, branch: "feature/service-api" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/service-api" });
        const branches = yield* core.listBranches({ cwd: tmp });

        expect(branches.isRepo).toBe(true);
        expect(
          branches.branches.find((branch: { current: boolean; name: string }) => branch.current)
            ?.name,
        ).toBe("feature/service-api");
      }),
    );

    it.effect(
      "reuses an existing remote when the target URL only differs by a trailing slash after .git",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;

          yield* git(tmp, ["remote", "add", "origin", "git@github.com:pingdotgg/t3code.git"]);

          const remoteName = yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "origin",
            url: "git@github.com:pingdotgg/t3code.git/",
          });

          expect(remoteName).toBe("origin");
          expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean)).toEqual(["origin"]);
        }),
    );

    it.effect("reports status details and dirty state", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const clean = yield* core.status({ cwd: tmp });
        expect(clean.hasWorkingTreeChanges).toBe(false);
        expect(clean.branch).toBeTruthy();

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        const dirty = yield* core.statusDetails(tmp);
        expect(dirty.hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect("computes ahead count against base branch when no upstream is configured", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "ahead of base\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const details = yield* core.statusDetails(tmp);
        expect(details.branch).toBe("feature/no-upstream-ahead");
        expect(details.hasUpstream).toBe(false);
        expect(details.aheadCount).toBe(1);
        expect(details.behindCount).toBe(0);
      }),
    );

    it.effect(
      "computes ahead count against origin/default when local default branch is missing",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/remote-base-only"]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of origin/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/remote-base-only");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect(
      "computes ahead count against a non-origin remote-prefixed gh-merge-base candidate",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const remoteName = "fork-seed";
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(source, ["remote", "add", remoteName, remote]);
          yield* git(source, ["push", "-u", remoteName, initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/non-origin-merge-base"]);
          yield* git(source, [
            "config",
            "branch.feature/non-origin-merge-base.gh-merge-base",
            `${remoteName}/${initialBranch}`,
          ]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of ${remoteName}/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/non-origin-merge-base");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect("skips push when no upstream is configured and branch is not ahead of base", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("skipped_up_to_date");
        expect(pushed.branch).toBe("feature/no-upstream-no-ahead");
        expect(pushed.setUpstream).toBeUndefined();
      }),
    );

    it.effect("pushes with upstream setup when no comparable base branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=trunk"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/no-base"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("origin/feature/no-base");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-base",
        );
      }),
    );

    it.effect("pushes with upstream setup to the only configured non-origin remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=main"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/fork-only"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("fork/feature/fork-only");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "fork/feature/fork-only",
        );
      }),
    );

    it.effect(
      "pushes with upstream setup when comparable base exists but remote branch is missing",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(tmp);
          const initialBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* writeTextFile(path.join(tmp, "default-ahead.txt"), "ahead on default\n");
          yield* git(tmp, ["add", "default-ahead.txt"]);
          yield* git(tmp, ["commit", "-m", "default ahead"]);

          const featureBranch = "feature/publish-no-upstream";
          yield* git(tmp, ["checkout", "-b", featureBranch]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(true);
          expect(pushed.upstreamBranch).toBe(`origin/${featureBranch}`);
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${featureBranch}`,
          );
          expect(yield* git(tmp, ["ls-remote", "--heads", "origin", featureBranch])).toContain(
            featureBranch,
          );
        }),
    );

    it.effect("prefers branch pushRemote over origin when setting upstream", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);

        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* listGitBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(tmp, ["remote", "add", "origin", origin]);
        yield* git(tmp, ["remote", "add", "fork", fork]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);

        const featureBranch = "feature/push-remote";
        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* git(tmp, ["config", `branch.${featureBranch}.pushRemote`, "fork"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "push to fork\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe(`fork/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `fork/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", "fork", featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect("updates the original fork PR branch from its renamed worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(fork, ["init", "--bare"]);

        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "jasonLaster", fork]);
        yield* git(tmp, ["checkout", "-b", "statemachine"]);
        yield* writeTextFile(path.join(tmp, "fork.txt"), "fork branch\n");
        yield* git(tmp, ["add", "fork.txt"]);
        yield* git(tmp, ["commit", "-m", "fork branch"]);
        yield* git(tmp, ["push", "-u", "jasonLaster", "statemachine"]);
        yield* git(tmp, ["checkout", initialBranch]);
        yield* git(tmp, ["branch", "-D", "statemachine"]);
        yield* git(tmp, [
          "checkout",
          "-b",
          "t3code/pr-488/statemachine",
          "--track",
          "jasonLaster/statemachine",
        ]);
        yield* git(tmp, ["config", "push.default", "current"]);
        yield* writeTextFile(path.join(tmp, "fork.txt"), "updated fork branch\n");
        yield* git(tmp, ["add", "fork.txt"]);
        yield* git(tmp, ["commit", "-m", "update reviewed PR branch"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);

        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(false);
        expect(pushed.upstreamBranch).toBe("jasonLaster/statemachine");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "jasonLaster/statemachine",
        );
        expect(
          yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "t3code/pr-488/statemachine"]),
        ).toBe("");
        expect(
          yield* git(tmp, [
            "config",
            "--get",
            "branch.t3code/pr-488/statemachine.gh-merge-base",
          ]).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
      }),
    );

    it.effect("includes command context when worktree removal fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const missingWorktreePath = path.join(tmp, "not-a-worktree");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(missingWorktreePath);

        const removeResult = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: missingWorktreePath }),
        );
        expect(removeResult._tag).toBe("Failure");
        if (removeResult._tag !== "Failure") {
          return;
        }
        const message = removeResult.failure.message;
        expect(message).toContain("git worktree remove");
        expect(message).toContain(tmp);
        expect(message).toContain(missingWorktreePath);
      }),
    );

    it.effect("eventually refreshes upstream counts after returning local status", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-B", initialBranch, "--track", `origin/${initialBranch}`]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const refreshed = yield* Deferred.make<void>();
        yield* core.subscribeStatusRefresh!(() => {
          Effect.runSync(Deferred.succeed(refreshed, undefined));
        });
        const details = yield* core.statusDetails(source);
        expect(details.branch).toBe(initialBranch);
        expect(details.aheadCount).toBe(0);
        yield* Deferred.await(refreshed);
        expect((yield* core.statusDetails(source)).behindCount).toBe(1);
      }),
    );

    it.effect("prepares commit context without staging and creates a validated commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "new content\n");
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary.length).toBeGreaterThan(0);
        expect(context!.stagedPatch.length).toBeGreaterThan(0);

        expect(yield* git(tmp, ["--no-optional-locks", "diff", "--cached", "--name-only"])).toBe(
          "",
        );
        const created = yield* core.commitPrepared(
          tmp,
          "Add README update",
          "- include updated content",
          context!,
        );
        if (created.status !== "created") throw new Error("Commit context unexpectedly changed.");
        expect(created.commitSha.length).toBeGreaterThan(0);
        expect(yield* git(tmp, ["log", "-1", "--pretty=%s"])).toBe("Add README update");
      }),
    );

    it.effect("prepareCommitContext includes selected files without staging the real index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp, ["a.txt"]);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).not.toContain("b.txt");

        expect(yield* git(tmp, ["--no-optional-locks", "diff", "--cached", "--name-only"])).toBe(
          "",
        );
        expect((yield* core.commitPrepared(tmp, "Add only a.txt", "", context!)).status).toBe(
          "created",
        );

        // b.txt should still be untracked after commit
        const statusAfter = yield* git(tmp, ["status", "--porcelain"]);
        expect(statusAfter).toContain("b.txt");
        expect(statusAfter).not.toContain("a.txt");
      }),
    );

    it.effect("prepareCommitContext includes all changes without staging the real index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).toContain("b.txt");
      }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* createGitBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* checkoutGitBranch({ cwd: tmp, branch: "feature/core-push" });

        yield* writeTextFile(path.join(tmp, "feature.txt"), "push me\n");
        const core = yield* GitCore;
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect((yield* core.commitPrepared(tmp, "Add feature file", "", context!)).status).toBe(
          "created",
        );

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/core-push",
        );

        const skipped = yield* core.pushCurrentBranch(tmp, null);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("pulls behind branch and then reports up-to-date", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* listGitBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const pulled = yield* core.pullCurrentBranch(source);
        expect(pulled.status).toBe("pulled");
        expect((yield* core.statusDetails(source)).behindCount).toBe(0);

        const skipped = yield* core.pullCurrentBranch(source);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("top-level pullGitBranch rejects when no upstream exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(pullGitBranch({ cwd: tmp }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message.toLowerCase()).toContain("no upstream");
        }
      }),
    );

    it.effect("lists branches when recency lookup fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitService = yield* GitService;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (!didFailRecency && input.args[0] === "for-each-ref") {
              didFailRecency = true;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.listBranchesRecency",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "timeout",
                }),
              );
            }
            return realGitService.execute(input);
          },
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );

    it.effect("falls back to empty remote branch data when remote lookups fail", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        const realGitService = yield* GitService;
        let didFailRemoteBranches = false;
        let didFailRemoteNames = false;
        const core = yield* makeIsolatedGitCore({
          execute: (input) => {
            if (input.args.join(" ") === "branch --no-color --remotes") {
              didFailRemoteBranches = true;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.listBranchesRemoteBranches",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "remote unavailable",
                }),
              );
            }
            if (input.args.join(" ") === "remote") {
              didFailRemoteNames = true;
              return Effect.fail(
                new GitCommandError({
                  operation: "git.test.listBranchesRemoteNames",
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: "remote unavailable",
                }),
              );
            }
            return realGitService.execute(input);
          },
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.every((branch) => !branch.isRemote)).toBe(true);
        expect(didFailRemoteBranches).toBe(true);
        expect(didFailRemoteNames).toBe(true);
      }),
    );
  });
});
