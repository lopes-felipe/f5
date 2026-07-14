import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Layer, Metric } from "effect";
import { describe, expect, it } from "vitest";

import { GitCoreLive } from "./GitCore.ts";
import { GitCommandError } from "../Errors.ts";
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

async function makeCore(gitService: GitServiceShape) {
  const layer = GitCoreLive.pipe(
    Layer.provide(Layer.succeed(GitService, gitService)),
    Layer.provide(NodeServices.layer),
  );
  return Effect.runPromise(Effect.service(GitCore).pipe(Effect.provide(layer)));
}

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

  it("parses porcelain status and combines staged and unstaged numstat", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) {
        return { stdout: "\n" };
      }
      if (argsEqual(input, ["status", "--porcelain=2", "--branch"])) {
        return {
          stdout:
            "# branch.head feature/parser\n# branch.upstream origin/feature/parser\n# branch.ab +2 -3\n1 .M N... 100644 100644 100644 a b src/a.ts\n? notes.txt\n",
        };
      }
      if (argsEqual(input, ["diff", "--numstat"])) {
        return { stdout: "4\t1\tsrc/a.ts\n2\t0\tnotes.txt\n" };
      }
      if (argsEqual(input, ["diff", "--cached", "--numstat"])) {
        return { stdout: "3\t2\tsrc/a.ts\n" };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    const status = await Effect.runPromise(core.statusDetails(process.cwd()));

    expect(status).toEqual({
      branch: "feature/parser",
      upstreamRef: "origin/feature/parser",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: "notes.txt", insertions: 2, deletions: 0 },
          { path: "src/a.ts", insertions: 7, deletions: 3 },
        ],
        insertions: 9,
        deletions: 3,
      },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 3,
    });
  });

  it("caches successful upstream refreshes across repeated status reads", async () => {
    const scripted = makeScriptedGitService((input) => {
      if (argsEqual(input, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])) {
        return { stdout: "origin/feature/cache\n" };
      }
      if (argsEqual(input, ["remote"])) {
        return { stdout: "origin\n" };
      }
      if (argsEqual(input, ["rev-parse", "--git-common-dir"])) {
        return { stdout: ".git\n" };
      }
      if (argsEqual(input, ["status", "--porcelain=2", "--branch"])) {
        return {
          stdout:
            "# branch.head feature/cache\n# branch.upstream origin/feature/cache\n# branch.ab +0 -0\n",
        };
      }
      return {};
    });
    const core = await makeCore(scripted.service);

    await Effect.runPromise(core.statusDetails(process.cwd()));
    await Effect.runPromise(core.statusDetails(process.cwd()));

    const refreshes = scripted.calls.filter((call) => call.args[0] === "fetch");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.args).toEqual([
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      "+refs/heads/feature/cache:refs/remotes/origin/feature/cache",
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
      "origin",
      "+refs/pull/77/head:refs/heads/pr/77-safe",
    ]);
  });
});
