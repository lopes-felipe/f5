import { holdsWorktreeLifecycleLock } from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Layer, ManagedRuntime, Metric, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GitCoreTestLive as GitCoreLive } from "../testLayers.ts";
import { GitCommandError } from "../Errors.ts";
import { GitServiceLive } from "./GitService.ts";
import { GitCore } from "../Services/GitCore.ts";
import {
  GitService,
  type ExecuteGitInput,
  type ExecuteGitResult,
  type GitServiceShape,
} from "../Services/GitService.ts";

interface ScriptedResult extends Partial<ExecuteGitResult> {
  readonly code?: number;
}

function makeScriptedGitService(resolve: (input: ExecuteGitInput) => ScriptedResult = () => ({})): {
  readonly service: GitServiceShape;
  readonly calls: ExecuteGitInput[];
} {
  const calls: ExecuteGitInput[] = [];
  return {
    calls,
    service: {
      execute: (input) => {
        calls.push(input);
        // Worktree add/remove take the cross-profile repository lock, which
        // resolves the git-common-dir on disk; answer with a real directory.
        if (argsEqual(input, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
          return Effect.succeed({ code: 0, stdout: `${process.cwd()}\n`, stderr: "" });
        }
        const scripted = resolve(input);
        return Effect.succeed({
          code: scripted.code ?? 0,
          stdout: scripted.stdout ?? "",
          stderr: scripted.stderr ?? "",
        });
      },
    },
  };
}

const runtimeDisposals = new Set<() => Promise<void>>();
afterEach(async () => {
  await Promise.all([...runtimeDisposals].map((dispose) => dispose()));
  runtimeDisposals.clear();
});
async function makeCore(gitService: GitServiceShape) {
  const layer = GitCoreLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-git-core-" })),
    Layer.provide(Layer.succeed(GitService, gitService)),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimeDisposals.add(() => runtime.dispose());
  return runtime.runPromise(Effect.service(GitCore));
}

it("places generated worktrees under the configured server worktree root", async () => {
  const scripted = makeScriptedGitService((input) => ({
    stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "",
  }));
  await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const core = yield* GitCore;
      const result = yield* core.createWorktree({
        cwd: process.cwd(),
        branch: "main",
        newBranch: "profile-test",
        path: null,
      });
      expect(result.worktree.path.startsWith(config.worktreesDir)).toBe(true);
      expect(scripted.calls.find((call) => call.args[0] === "worktree")?.env).toBeUndefined();
      expect(scripted.calls.find((call) => call.args[0] === "worktree")?.timeoutMs).toBe(300_000);
      expect(scripted.calls.find((call) => call.args[0] === "worktree")?.args).toContain(
        result.worktree.path,
      );
      const addArgs = scripted.calls.find((call) => call.args[0] === "worktree")!.args;
      expect(addArgs[addArgs.indexOf(result.worktree.path) - 1]).toBe("--");
    }).pipe(
      Effect.provide(
        GitCoreLive.pipe(
          Layer.provide(Layer.succeed(GitService, scripted.service)),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "f5-worktree-root-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});

it("rejects option-shaped worktree refs before Git calls or ownership allocation", async () => {
  const scripted = makeScriptedGitService((input) => ({
    stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "",
  }));
  const core = await makeCore(scripted.service);
  for (const fields of [
    { newBranch: "--delete" },
    { branch: "--orphan" },
    { newBranch: "safe", baseRefName: "--orphan" },
    { newBranch: "invalid\0branch" },
    { newBranch: "" },
  ]) {
    await expect(
      Effect.runPromise(
        core.createWorktree({
          cwd: process.cwd(),
          branch: "main",
          path: null,
          ...fields,
        }),
      ),
    ).rejects.toThrow("Invalid worktree ref name");
  }
  for (const branch of ["--orphan", "invalid\0branch", ""]) {
    await expect(
      Effect.runPromise(
        core.ensureWorktree({ cwd: process.cwd(), path: "/unused-worktree", branch }),
      ),
    ).rejects.toThrow("Invalid worktree ref name");
  }
  expect(scripted.calls).toEqual([]);
});

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function histogramCount(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Histogram" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Histogram" ? snapshot.state.count : 0;
}

const argsEqual = (input: ExecuteGitInput, args: ReadonlyArray<string>) =>
  input.args.length === args.length && input.args.every((value, index) => value === args[index]);

describe("GitCore unit", () => {
  it("preserves the process environment for authenticated remote fetches", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const scripted = makeScriptedGitService((input) =>
      input.args[0] === "rev-parse" ? { stdout: `${commit}\n` } : {},
    );
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(
        core.fetchRemoteBranchCommit({
          cwd: process.cwd(),
          remoteName: "origin",
          branch: "main",
        }),
      ),
    ).resolves.toMatchObject({ commit, remoteName: "origin", branch: "main" });

    const fetch = scripted.calls.find((call) => call.args[0] === "fetch");
    expect(fetch?.args).toEqual([
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(fetch?.env).toMatchObject({
      PATH: process.env.PATH,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    });
  });

  it.each([
    "error: cannot lock ref 'refs/remotes/origin/main': is at 1234 but expected 5678",
    "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
  ])("retries a base fetch once when another fetch held the ref: %s", async (stderr) => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    let fetches = 0;
    const scripted = makeScriptedGitService((input) => {
      if (input.args[0] === "rev-parse") return { stdout: `${commit}\n` };
      if (input.args[0] === "fetch" && ++fetches === 1) return { code: 1, stderr };
      return {};
    });
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(
        core.fetchRemoteBranchCommit({ cwd: process.cwd(), remoteName: "origin", branch: "main" }),
      ),
    ).resolves.toMatchObject({ commit });
    expect(fetches).toBe(2);
  });

  it("fails a base fetch without retrying when the remote is unreachable", async () => {
    let fetches = 0;
    const scripted = makeScriptedGitService((input) => {
      if (input.args[0] !== "fetch") return {};
      fetches += 1;
      return { code: 128, stderr: "fatal: Could not resolve host: example.test" };
    });
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(
        core.fetchRemoteBranchCommit({ cwd: process.cwd(), remoteName: "origin", branch: "main" }),
      ),
    ).rejects.toThrow("Git could not reach the remote");
    expect(fetches).toBe(1);
  });

  it("rejects option-like remote names before invoking git fetch", async () => {
    const scripted = makeScriptedGitService();
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(
        core.fetchRemoteBranchCommit({
          cwd: process.cwd(),
          remoteName: "--upload-pack=malicious",
          branch: "main",
        }),
      ),
    ).rejects.toThrow("Invalid remote name");
    expect(scripted.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("records observability metrics for git command execution", async () => {
    const before = await Effect.runPromise(Metric.snapshot);
    const scripted = makeScriptedGitService(() => ({ stdout: "test@example.com\n" }));
    const core = await makeCore(scripted.service);

    const value = await Effect.runPromise(core.readConfigValue("/tmp/repo", "user.email"));

    expect(value).toBe("test@example.com");
    const after = await Effect.runPromise(Metric.snapshot);
    expect(
      counterValue(after, "t3_git_commands_total", {
        operation: "GitCore.readConfigValue",
        outcome: "success",
      }) -
        counterValue(before, "t3_git_commands_total", {
          operation: "GitCore.readConfigValue",
          outcome: "success",
        }),
    ).toBe(1);
    expect(
      histogramCount(after, "t3_git_command_duration", {
        operation: "GitCore.readConfigValue",
      }) -
        histogramCount(before, "t3_git_command_duration", {
          operation: "GitCore.readConfigValue",
        }),
    ).toBe(1);
  });

  it("lists every configured remote with its fetch URL", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--git-common-dir"])) return { stdout: ".git\n" };
      if (argsEqual(input, ["remote", "-v"])) {
        return {
          stdout:
            "origin\thttps://github.com/octo/repo.git (fetch)\norigin\thttps://github.com/octo/repo.git (push)\nupstream\tgit@gitlab.com:octo/repo.git (fetch)\nupstream\tgit@gitlab.com:octo/repo.git (push)\n",
        };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    await expect(Effect.runPromise(core.listRemotes("/tmp/repo"))).resolves.toEqual([
      { name: "origin", url: "https://github.com/octo/repo.git" },
      { name: "upstream", url: "git@gitlab.com:octo/repo.git" },
    ]);
  });

  it("parses porcelain status and combines staged and unstaged numstat", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) {
        return { stdout: "\n" };
      }
      if (argsEqual(input, ["status", "--porcelain=2", "--branch", "-z"])) {
        return {
          stdout:
            "# branch.head feature/parser\x00# branch.upstream origin/feature/parser\x00# branch.ab +2 -3\x001 .M N... 100644 100644 100644 a b src/a.ts\x00? notes.txt\x00",
        };
      }
      if (argsEqual(input, ["diff-files", "-M", "--numstat", "-z"])) {
        return { stdout: "4\t1\tsrc/a.ts\x002\t0\tnotes.txt\x00" };
      }
      if (argsEqual(input, ["diff", "--cached", "--numstat", "-z"])) {
        return { stdout: "3\t2\tsrc/a.ts\x00" };
      }
      if (argsEqual(input, ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])) {
        return { stdout: "3\t1\tsrc/a.ts\x002\t0\tnotes.txt\x00" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const status = await Effect.runPromise(core.statusDetails(process.cwd()));

    expect(
      scripted.calls.find((call) => argsEqual(call, ["status", "--porcelain=2", "--branch", "-z"]))
        ?.env,
    ).toMatchObject({
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      PATH: process.env.PATH,
      GIT_OPTIONAL_LOCKS: "0",
    });

    expect(status).toEqual({
      branch: "feature/parser",
      upstreamRef: "origin/feature/parser",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: "notes.txt", insertions: 2, deletions: 0 },
          { path: "src/a.ts", insertions: 7, deletions: 3 },
        ],
        insertions: 5,
        deletions: 1,
      },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 3,
    });
  });

  it("lists worktrees when older Git rejects the NUL option", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["worktree", "list", "--porcelain", "-z"]))
        return { code: 129, stderr: "error: unknown switch `z'" };
      if (argsEqual(input, ["worktree", "list", "--porcelain"]))
        return {
          stdout: `worktree ${process.cwd()}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\n`,
        };
      return {};
    });
    const core = await makeCore(scripted.service);
    await expect(Effect.runPromise(core.listWorktrees(process.cwd()))).resolves.toMatchObject([
      { path: process.cwd(), branch: "main", headSha: "a".repeat(40), isMain: true },
    ]);
    expect(scripted.calls.filter((call) => call.args[0] === "worktree")).toHaveLength(2);
  });

  it("keeps unrelated worktree-list failures visible without a compatibility retry", async () => {
    const scripted = makeScriptedGitService(() => ({
      code: 128,
      stderr: "fatal: not a git repository",
    }));
    const core = await makeCore(scripted.service);
    await expect(Effect.runPromise(core.listWorktrees(process.cwd()))).rejects.toThrow(
      "not a git repository",
    );
    expect(scripted.calls.filter((call) => call.args[0] === "worktree")).toHaveLength(1);
  });

  it("limits generated commit context to the selected paths", async () => {
    const indexPath = join(tmpdir(), `f5-fake-index-${crypto.randomUUID()}`);
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--git-path", "index"])) return { stdout: indexPath };
      if (input.args.includes("--name-status")) return { stdout: "M\tsrc/selected.ts\n" };
      if (input.args.includes("--patch")) return { stdout: "+selected\n" };
      return {};
    });
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(core.prepareCommitContext(process.cwd(), ["src/selected.ts"])),
    ).resolves.toEqual({
      stagedSummary: "M\tsrc/selected.ts",
      stagedPatch: "+selected\n",
    });
    expect(
      scripted.calls
        .filter((call) => call.args.includes("add"))
        .every((call) => call.env?.GIT_INDEX_FILE?.startsWith(`${indexPath}.f5-`)),
    ).toBe(true);
    expect(scripted.calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--cached",
      "--name-status",
      "--",
      ":(literal)src/selected.ts",
    ]);
    expect(scripted.calls.map((call) => call.args)).toContainEqual([
      "diff",
      "--cached",
      "--patch",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--minimal",
      "--",
      ":(literal)src/selected.ts",
    ]);
  });

  it("commits the full index during a merge even when selected paths were requested", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-git-core-merge-"));
    const mergeHeadPath = path.join(cwd, "MERGE_HEAD");
    fs.writeFileSync(mergeHeadPath, "0123456789abcdef\n");
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--git-path", "MERGE_HEAD"])) {
        return { stdout: `${mergeHeadPath}\n` };
      }
      if (argsEqual(input, ["rev-parse", "HEAD"])) return { stdout: "abc123\n" };
      return {};
    });
    const core = await makeCore(scripted.service);

    try {
      await expect(
        Effect.runPromise(core.commit(cwd, "Resolve merge", "", ["src/selected.ts"])),
      ).resolves.toEqual({ commitSha: "abc123" });
      expect(scripted.calls.map((call) => call.args)).toContainEqual([
        "commit",
        "-m",
        "Resolve merge",
      ]);
      expect(scripted.calls.some((call) => call.args.includes("--only"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "caches successful upstream refreshes across repeated status reads (legacy Git=%s)",
    async (legacy) => {
      const scripted = makeScriptedGitService((input) => {
        if (legacy && input.args[0] === "fetch" && input.args.includes("--no-write-fetch-head"))
          return { code: 129, stderr: "error: unknown option `no-write-fetch-head'" };
        if (
          argsEqual(input, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        ) {
          return { stdout: "origin/feature/cache\n" };
        }
        if (argsEqual(input, ["rev-parse", "--verify", "refs/remotes/origin/feature/cache"]))
          return { stdout: `${"a".repeat(40)}\n` };
        if (
          input.args[0] === "rev-parse" &&
          input.args[1] === "--verify" &&
          input.args[2]?.startsWith("refs/f5/status/")
        )
          return { stdout: `${"b".repeat(40)}\n` };
        if (argsEqual(input, ["remote"])) {
          return { stdout: "origin\n" };
        }
        if (argsEqual(input, ["rev-parse", "--git-common-dir"])) {
          return { stdout: ".git\n" };
        }
        if (argsEqual(input, ["status", "--porcelain=2", "--branch", "-z"])) {
          return {
            stdout:
              "# branch.head feature/cache\x00# branch.upstream origin/feature/cache\x00# branch.ab +0 -0\x00",
          };
        }
        return {};
      });
      const core = await makeCore(scripted.service);

      const refreshed = Promise.withResolvers<void>();
      await Effect.runPromise(core.subscribeStatusRefresh!(() => refreshed.resolve()));
      await Effect.runPromise(core.statusDetails(process.cwd()));
      await refreshed.promise;
      await Effect.runPromise(core.drainUpstreamRefreshes!(process.cwd()));
      await Effect.runPromise(core.statusDetails(process.cwd()));

      const refreshes = scripted.calls.filter((call) => call.args[0] === "fetch");
      expect(refreshes).toHaveLength(legacy ? 2 : 1);
      expect(refreshes[0]?.args).toEqual([
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--refmap=",
        "--",
        "origin",
        expect.stringMatching(/^\+refs\/heads\/feature\/cache:refs\/f5\/status\//),
      ]);
      expect(scripted.calls.map((call) => call.args)).toContainEqual([
        "update-ref",
        "refs/remotes/origin/feature/cache",
        "b".repeat(40),
        "a".repeat(40),
      ]);
      expect(
        scripted.calls.some(
          (call) =>
            call.args[0] === "update-ref" &&
            call.args[1] === "-d" &&
            call.args[2]?.startsWith("refs/f5/status/"),
        ),
      ).toBe(true);
      expect(
        scripted.calls.filter((call) =>
          argsEqual(call, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
        ),
      ).toHaveLength(1);
      expect(
        scripted.calls.filter((call) => argsEqual(call, ["rev-parse", "--git-common-dir"])),
      ).toHaveLength(1);
      expect(scripted.calls.filter((call) => argsEqual(call, ["remote"]))).toHaveLength(1);
      expect(scripted.calls.filter((call) => call.args[0] === "fetch")).toHaveLength(
        legacy ? 2 : 1,
      );
      if (legacy)
        expect(scripted.calls.filter((call) => call.args[0] === "fetch")[1]?.args).toEqual([
          "fetch",
          "--quiet",
          "--no-tags",
          "--refmap=",
          "--",
          "origin",
          expect.stringMatching(/^\+refs\/heads\/feature\/cache:refs\/f5\/status\//),
        ]);
    },
  );

  it("reports aggregate counts as unavailable for an unborn HEAD", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["status", "--porcelain=2", "--branch", "-z"])) {
        return {
          stdout: "# branch.oid (initial)\x00# branch.head main\x00? README.md\x00",
        };
      }
      if (argsEqual(input, ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])) {
        return { code: 128, stderr: "fatal: ambiguous argument 'HEAD'" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const status = await Effect.runPromise(core.statusDetails(process.cwd()));

    expect(status.workingTree).toMatchObject({
      insertions: 0,
      deletions: 0,
      countUnavailableReason: "unborn_head",
    });
    expect(status.workingTree.files).toEqual([{ path: "README.md", insertions: 0, deletions: 0 }]);
  });

  it("preserves spaces, unicode, and the destination path for renames", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["status", "--porcelain=2", "--branch", "-z"])) {
        return {
          stdout:
            "# branch.head main\x002 R. N... 100644 100644 100644 a b R100 dir/new name.txt\x00dir/old name.txt\x001 .M N... 100644 100644 100644 a b café.txt\x00",
        };
      }
      if (argsEqual(input, ["diff", "--cached", "--numstat", "-z"])) {
        return { stdout: "0\t0\t\x00dir/old name.txt\x00dir/new name.txt\x00" };
      }
      if (argsEqual(input, ["diff-files", "-M", "--numstat", "-z"])) {
        return { stdout: "1\t0\tcafé.txt\x00" };
      }
      if (argsEqual(input, ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"])) {
        return {
          stdout: "0\t0\t\x00dir/old name.txt\x00dir/new name.txt\x001\t0\tcafé.txt\x00",
        };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const status = await Effect.runPromise(core.statusDetails(process.cwd()));

    expect(status.workingTree.files).toEqual([
      { path: "café.txt", insertions: 1, deletions: 0 },
      { path: "dir/new name.txt", insertions: 0, deletions: 0 },
    ]);
  });

  it("parses local and slash-containing remote names without pseudo refs", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["branch", "--no-color"])) {
        return { stdout: "  main\n* feature/current\n" };
      }
      if (argsEqual(input, ["branch", "--no-color", "--remotes"])) {
        return {
          stdout:
            "  team/fork/feature/current\n  team/fork/HEAD -> team/fork/main\n  origin/main\n",
        };
      }
      if (argsEqual(input, ["remote"])) {
        return { stdout: "origin\nteam/fork\n" };
      }
      if (argsEqual(input, ["symbolic-ref", "refs/remotes/origin/HEAD"])) {
        return { stdout: "refs/remotes/origin/main\n" };
      }
      if (input.args[0] === "for-each-ref") {
        return { stdout: "feature/current\t20\nmain\t10\nteam/fork/feature/current\t30\n" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const result = await Effect.runPromise(core.listBranches({ cwd: process.cwd() }));

    expect(result.hasOriginRemote).toBe(true);
    expect(result.branches.map((branch) => branch.name)).toEqual([
      "feature/current",
      "main",
      "team/fork/feature/current",
      "origin/main",
    ]);
    expect(result.branches[2]).toMatchObject({ isRemote: true, remoteName: "team/fork" });
  });

  it("returns a non-repository result for git's repository error", async () => {
    const scripted = makeScriptedGitService((input) =>
      argsEqual(input, ["branch", "--no-color"])
        ? { code: 128, stderr: "fatal: not a git repository" }
        : {},
    );
    const core = await makeCore(scripted.service);

    await expect(Effect.runPromise(core.listBranches({ cwd: process.cwd() }))).resolves.toEqual({
      branches: [],
      isRepo: false,
      hasOriginRemote: false,
    });
  });

  it("falls back to local branches when remote lookups fail", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["branch", "--no-color"])) {
        return { stdout: "* main\n" };
      }
      if (argsEqual(input, ["branch", "--no-color", "--remotes"]) || argsEqual(input, ["remote"])) {
        return { code: 1, stderr: "remote lookup failed" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const result = await Effect.runPromise(core.listBranches({ cwd: process.cwd() }));

    expect(result).toEqual({
      branches: [
        {
          name: "main",
          current: true,
          isRemote: false,
          isDefault: false,
          worktreePath: null,
        },
      ],
      isRepo: true,
      hasOriginRemote: false,
    });
  });

  it("reuses a remote whose normalized fetch URL already matches", async () => {
    const scripted = makeScriptedGitService((input) =>
      argsEqual(input, ["remote", "-v"])
        ? {
            stdout:
              "fork-alias https://github.com/octocat/f5.git (fetch)\nfork-alias git@github.com:octocat/f5.git (push)\n",
          }
        : {},
    );
    const core = await makeCore(scripted.service);

    const remote = await Effect.runPromise(
      core.ensureRemote({
        cwd: process.cwd(),
        preferredName: "Octo Cat",
        url: "https://github.com/octocat/f5/",
      }),
    );

    expect(remote).toBe("fork-alias");
    expect(scripted.calls.some((call) => call.args[1] === "add")).toBe(false);
  });

  it("sanitizes and suffixes a conflicting preferred remote name", async () => {
    const scripted = makeScriptedGitService((input) =>
      argsEqual(input, ["remote", "-v"])
        ? { stdout: "Octo-Cat https://github.com/other/repo (fetch)\n" }
        : {},
    );
    const core = await makeCore(scripted.service);

    const remote = await Effect.runPromise(
      core.ensureRemote({
        cwd: process.cwd(),
        preferredName: " Octo Cat ",
        url: "https://github.com/octocat/f5.git",
      }),
    );

    expect(remote).toBe("Octo-Cat-1");
    expect(scripted.calls.at(-1)?.args).toEqual([
      "remote",
      "add",
      "--",
      "Octo-Cat-1",
      "https://github.com/octocat/f5.git",
    ]);
  });

  it("uses an argument separator and finds an available suffix when renaming", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (input.args[0] === "show-ref") {
        const ref = input.args.at(-1);
        return { code: ref === "refs/heads/feature/new-1" ? 1 : 0 };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const result = await Effect.runPromise(
      core.renameBranch({
        cwd: process.cwd(),
        oldBranch: "feature/old;echo unsafe",
        newBranch: "feature/new",
      }),
    );

    expect(result).toEqual({ branch: "feature/new-1" });
    expect(scripted.calls.at(-1)?.args).toEqual([
      "branch",
      "-m",
      "--",
      "feature/old;echo unsafe",
      "feature/new-1",
    ]);
  });

  it("does not invoke Git for a no-op rename", async () => {
    const scripted = makeScriptedGitService();
    const core = await makeCore(scripted.service);

    await expect(
      Effect.runPromise(
        core.renameBranch({ cwd: process.cwd(), oldBranch: "same", newBranch: "same" }),
      ),
    ).resolves.toEqual({ branch: "same" });
    expect(scripted.calls).toHaveLength(0);
  });

  it("maps non-zero command results to GitCommandError with command context", async () => {
    const scripted = makeScriptedGitService(() => ({ code: 128, stderr: "permission denied" }));
    const core = await makeCore(scripted.service);

    const exit = await Effect.runPromiseExit(core.initRepo({ cwd: process.cwd() }));

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause);
      expect(failure).toBeInstanceOf(GitCommandError);
      expect(String(failure)).toContain("permission denied");
      expect(String(failure)).toContain("git init");
    }
  });

  it("builds a scoped pull-request fetch refspec without shell interpolation", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["remote", "get-url", "origin"])) {
        return { stdout: "https://github.com/t3tools/f5.git\n" };
      }
      if (argsEqual(input, ["remote"])) {
        return { stdout: "origin\n" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    await Effect.runPromise(
      core.fetchPullRequestBranch({ cwd: process.cwd(), prNumber: 77, branch: "pr/77-safe" }),
    );

    expect(scripted.calls.at(-1)?.args).toEqual([
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      "origin",
      "+refs/pull/77/head:refs/heads/pr/77-safe",
    ]);
  });
});
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("redacts remote output from failed fetches while explaining the cause", async () => {
  const secret = "https://user:private-token@example.test/repo";
  const scripted = makeScriptedGitService((input) =>
    input.args[0] === "fetch"
      ? { code: 128, stdout: secret, stderr: `fatal: Authentication failed for '${secret}'` }
      : { stdout: input.args[0] === "remote" ? "origin\n" : "" },
  );
  const core = await makeCore(scripted.service);
  const result = await Effect.runPromise(
    core
      .fetchRemoteBranch({
        cwd: process.cwd(),
        remoteName: "origin",
        remoteBranch: "main",
        localBranch: "feature",
      })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure.message).toContain("could not authenticate");
    expect(result.failure.command).toContain("origin");
    expect(result.failure.command).toContain("refs/heads/main");
    expect(JSON.stringify(result.failure)).not.toContain("private-token");
  }
});

it("refuses to remove an unregistered directory", async () => {
  const scripted = makeScriptedGitService();
  const core = await makeCore(scripted.service);
  await expect(
    Effect.runPromise(core.removeWorktree({ cwd: process.cwd(), path: process.cwd() })),
  ).rejects.toThrow("not an unlocked linked worktree");
  expect(scripted.calls.some((call) => call.args[1] === "remove")).toBe(false);
});

it("returns missing worktree branches without running git", async () => {
  const scripted = makeScriptedGitService();
  const core = await makeCore(scripted.service);
  const result = await Effect.runPromise(
    core.listBranches({ cwd: `${process.cwd()}/missing-${crypto.randomUUID()}` }),
  );
  expect(result).toMatchObject({ worktreeMissing: true, branches: [] });
  expect(scripted.calls).toEqual([]);
});

it.each(["none", "shallow", "recursive"] as const)(
  "initializes worktree submodules using %s policy without local-file transport",
  async (submodules) => {
    const scripted = makeScriptedGitService((input) => {
      // Like a real checkout of a repository with submodules.
      if (input.args[0] === "worktree" && input.args[1] === "add") {
        const worktreePath = input.args[input.args.length - 2]!;
        mkdirSync(worktreePath, { recursive: true });
        writeFileSync(`${worktreePath}/.gitmodules`, '[submodule "lib"]\n');
      }
      return {
        stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "",
        code: input.args.includes("submodule") ? 1 : 0,
      };
    });
    const core = await makeCore(scripted.service);
    const result = await Effect.runPromise(
      core.createWorktree({ cwd: process.cwd(), branch: "main", path: null, submodules }),
    );
    expect(result.worktree.branch).toBe("main");
    const calls = scripted.calls.filter((call) => call.args.includes("submodule"));
    if (submodules === "none") expect(calls).toHaveLength(0);
    else {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([
        "-c",
        "protocol.file.allow=never",
        "submodule",
        "update",
        "--init",
        ...(submodules === "recursive" ? ["--recursive"] : []),
      ]);
      expect(calls[0]!.cwd).toBe(result.worktree.path);
    }
  },
);

it("retains active receipt ownership while initializing submodules outside lifecycle locks", async () => {
  const scripted = makeScriptedGitService((input) => {
    if (input.args[0] === "worktree" && input.args[1] === "add") {
      const target = input.args[input.args.length - 2]!;
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".gitmodules"), '[submodule "lib"]\n');
    }
    return { stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "" };
  });
  let observed = false;
  const core = await makeCore({
    execute: (input) =>
      scripted.service.execute(input).pipe(
        Effect.tap(() =>
          input.args.includes("submodule")
            ? Effect.gen(function* () {
                observed = true;
                expect((yield* core.readWorktreePreparation(input.cwd))?.phase).toBe(
                  "setup_running",
                );
                expect(yield* holdsWorktreeLifecycleLock(input.cwd)).toBe(false);
              }).pipe(Effect.orDie)
            : Effect.void,
        ),
      ),
  });
  const created = await Effect.runPromise(
    core.createWorktree({
      cwd: process.cwd(),
      branch: "main",
      path: null,
      submodules: "recursive",
      preparation: { owner: "pr:pending", runSetupScript: true },
    }),
  );
  expect(observed).toBe(true);
  expect(
    (await Effect.runPromise(core.readWorktreePreparation(created.worktree.path)))?.phase,
  ).toBe("checkout_created");
});

describe("failed worktree add", () => {
  const failAdd = (createDir: boolean) =>
    makeScriptedGitService((input) => {
      if (input.args[0] === "worktree" && input.args[1] === "add") {
        if (createDir) mkdirSync(input.args[input.args.length - 2]!, { recursive: true });
        return { code: 128, stderr: "fatal: worktree add failed\n" };
      }
      return { stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "" };
    });
  const attempt = async (path: string, createDir: boolean) => {
    const claimed: string[] = [];
    const core = await makeCore(failAdd(createDir).service);
    const exit = await Effect.runPromise(
      core
        .createWorktree({
          cwd: process.cwd(),
          branch: "main",
          path,
          progress: { onWorktreeClaimed: (claimedPath) => claimed.push(claimedPath) },
        })
        .pipe(Effect.exit),
    );
    expect(exit._tag).toBe("Failure");
    return claimed;
  };

  it("never claims a path that existed before the add", async () => {
    const existing = mkdtempSync(join(tmpdir(), "f5-existing-worktree-"));
    try {
      expect(await attempt(existing, false)).toEqual([]);
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("claims a new path the failed add left behind", async () => {
    const parent = mkdtempSync(join(tmpdir(), "f5-new-worktree-"));
    const target = join(parent, "worktree");
    try {
      expect(await attempt(target, true)).toEqual([target]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

it("skips submodule initialization when the checkout has no .gitmodules", async () => {
  const scripted = makeScriptedGitService((input) => ({
    stdout: input.args[0] === "rev-parse" ? "a".repeat(40) : "",
  }));
  const core = await makeCore(scripted.service);
  await Effect.runPromise(
    core.createWorktree({
      cwd: process.cwd(),
      branch: "main",
      path: null,
      submodules: "recursive",
    }),
  );
  expect(scripted.calls.filter((call) => call.args.includes("submodule"))).toHaveLength(0);
});

it("preserves existing branches during forge head materialization, including races", async () => {
  const scripted = makeScriptedGitService((input) =>
    input.args[0] === "branch"
      ? { code: 128, stderr: "fatal: a branch named 'existing' already exists" }
      : {},
  );
  const core = await makeCore(scripted.service);
  const result = await Effect.runPromise(
    core
      .fetchRemoteBranch({
        cwd: process.cwd(),
        remoteName: "origin",
        remoteBranch: "feature",
        localBranch: "existing",
        preserveExisting: true,
      })
      .pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  expect(scripted.calls.find((call) => call.args[0] === "fetch")?.args.at(-1)).toBe(
    "refs/heads/feature:refs/remotes/origin/feature",
  );
  expect(scripted.calls.find((call) => call.args[0] === "branch")?.args).toEqual([
    "branch",
    "--",
    "existing",
    "origin/feature",
  ]);
  expect(scripted.calls.flatMap((call) => call.args)).not.toContain("--force");
});

it("rejects option-shaped checkout targets without running a checkout", async () => {
  const scripted = makeScriptedGitService();
  const core = await makeCore(scripted.service);
  await expect(
    Effect.runPromise(
      core.checkoutBranch({ cwd: process.cwd(), branch: "--orphan=intruder" }).pipe(Effect.scoped),
    ),
  ).rejects.toThrow("Invalid branch name");
  expect(scripted.calls.some((call) => call.args[0] === "checkout")).toBe(false);
});

describe("pull output beyond the output cap", () => {
  const runGit = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  // A fast-forward that prints over 1 MB takes thousands of files, so the real pull's output is
  // padded past the cap instead.
  async function makePaddedCore(stream: "stdout" | "stderr") {
    const padding = new Uint8Array(1_000_001).fill(0x20);
    const spawnerLayer = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        return ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            const isPull =
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("pull") &&
              command.args.includes("--ff-only");
            return isPull
              ? ChildProcessSpawner.makeHandle({
                  ...handle,
                  [stream]: Stream.concat(handle[stream], Stream.make(padding)),
                })
              : handle;
          }),
        );
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const layer = GitCoreLive.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "f5-git-core-pull-" })),
      Layer.provide(GitServiceLive),
      Layer.provide(Layer.merge(NodeServices.layer, spawnerLayer)),
    );
    return Effect.runPromise(Effect.service(GitCore).pipe(Effect.provide(layer)));
  }

  function cloneBehindRemote() {
    const root = mkdtempSync(join(tmpdir(), "f5-git-core-pull-"));
    const [cwd, remote, updater] = ["local", "remote.git", "updater"].map((name) =>
      join(root, name),
    ) as [string, string, string];
    for (const dir of [cwd, remote, updater]) mkdirSync(dir);
    const configure = (repo: string) => {
      runGit(repo, ["config", "user.email", "test@test.com"]);
      runGit(repo, ["config", "user.name", "Test"]);
      runGit(repo, ["config", "commit.gpgsign", "false"]);
    };
    runGit(remote, ["init", "--bare", "--initial-branch=main"]);
    runGit(cwd, ["init", "--initial-branch=main"]);
    configure(cwd);
    writeFileSync(join(cwd, "README.md"), "initial\n");
    runGit(cwd, ["add", "README.md"]);
    runGit(cwd, ["commit", "-m", "initial"]);
    runGit(cwd, ["remote", "add", "origin", remote]);
    runGit(cwd, ["push", "-u", "origin", "main"]);
    runGit(updater, ["clone", remote, "."]);
    configure(updater);
    writeFileSync(join(updater, "remote.txt"), "remote\n");
    runGit(updater, ["add", "remote.txt"]);
    runGit(updater, ["commit", "-m", "remote commit"]);
    runGit(updater, ["push", "origin", "HEAD:main"]);
    return { root, cwd, remoteHead: runGit(updater, ["rev-parse", "HEAD"]) };
  }

  it.each(["stdout", "stderr"] as const)(
    "reports a fast-forward whose %s passes the cap as pulled",
    async (stream) => {
      const core = await makePaddedCore(stream);
      const { root, cwd, remoteHead } = cloneBehindRemote();
      try {
        const result = await Effect.runPromise(core.pullCurrentBranch(cwd));
        expect(result.status).toBe("pulled");
        expect(runGit(cwd, ["rev-parse", "HEAD"])).toBe(remoteHead);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("still fails a pull that Git rejects, whatever its output size", async () => {
    const core = await makePaddedCore("stderr");
    const { root, cwd } = cloneBehindRemote();
    try {
      // A local commit the remote lacks: `pull --ff-only` cannot fast-forward.
      writeFileSync(join(cwd, "local.txt"), "local\n");
      runGit(cwd, ["add", "local.txt"]);
      runGit(cwd, ["commit", "-m", "local commit"]);

      const error = await Effect.runPromise(Effect.flip(core.pullCurrentBranch(cwd)));
      expect(error.operation).toBe("GitCore.pullCurrentBranch.pull");
      expect(error.detail).not.toContain("exceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

it("terminates option parsing before configuration keys", async () => {
  const scripted = makeScriptedGitService();
  const core = await makeCore(scripted.service);
  await Effect.runPromise(core.readConfigValue(process.cwd(), "--list"));
  expect(scripted.calls.at(-1)?.args).toEqual(["config", "--get", "--", "--list"]);
});
