import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { GitServiceLive } from "../../../src/git/Layers/GitService.ts";
import { GitService } from "../../../src/git/Services/GitService.ts";
import {
  MAX_EXCERPT_CHARS,
  makeUpstreamGit,
  UpstreamSigningError,
  type UpstreamGitTimeouts,
} from "../../../src/upstreamPorts/git.ts";

const layer = Layer.provideMerge(GitServiceLive, NodeServices.layer);
const directories: string[] = [];
// The extended suite runs tests concurrently, so per-test cleanup would remove live fixtures.
afterAll(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "f5-upstream-git-"));
  directories.push(cwd);
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Upstream Test");
  git(cwd, "config", "user.email", "upstream@example.test");
  git(cwd, "config", "commit.gpgsign", "false");
  // Background auto-gc would race the fixture cleanup.
  git(cwd, "config", "gc.auto", "0");
  return cwd;
}

const write = (cwd: string, file: string, contents: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), contents);
};

const runWith = <A, E>(
  use: (upstream: ReturnType<typeof makeUpstreamGit>) => Effect.Effect<A, E>,
  timeouts: Partial<UpstreamGitTimeouts> = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* GitService;
      return yield* use(makeUpstreamGit(service.execute, timeouts));
    }).pipe(Effect.provide(layer)),
  );

const runExit = <A, E>(
  use: (upstream: ReturnType<typeof makeUpstreamGit>) => Effect.Effect<A, E>,
  timeouts: Partial<UpstreamGitTimeouts> = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* GitService;
      return yield* Effect.flip(use(makeUpstreamGit(service.execute, timeouts)));
    }).pipe(Effect.provide(layer)),
  );

describe("deleteBranch", () => {
  it("deletes a branch only at the expected tip", async () => {
    const cwd = repo();
    write(cwd, "a.txt", "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    const head = git(cwd, "rev-parse", "HEAD");
    git(cwd, "branch", "f5/upstream-ledger-old", head);
    await runExit((upstream) =>
      upstream.deleteBranch(cwd, "f5/upstream-ledger-old", "0".repeat(39) + "1"),
    );
    expect(git(cwd, "rev-parse", "refs/heads/f5/upstream-ledger-old")).toBe(head);
    await runWith((upstream) => upstream.deleteBranch(cwd, "f5/upstream-ledger-old", head));
    expect(git(cwd, "branch", "--list", "f5/upstream-ledger-old")).toBe("");
  });
});

describe("commitFilesToBranch", () => {
  it("leaves the working tree, index, and HEAD untouched", async () => {
    const cwd = repo();
    write(cwd, "upstream/topics/2026-10.json", "{}\n");
    write(cwd, "README.md", "hi\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    write(cwd, "README.md", "dirty\n");
    git(cwd, "add", "README.md");
    write(cwd, "untracked.txt", "x");
    const head = git(cwd, "rev-parse", "HEAD");
    const statusBefore = git(cwd, "status", "--porcelain");

    const sha = await runWith((upstream) =>
      upstream.commitFilesToBranch({
        cwd,
        branch: "f5/upstream-ledger-test",
        parent: head,
        expectedTip: null,
        files: new Map([
          ["upstream/topics/2026-10.json", '{\n  "a": 1\n}\n'],
          ["upstream/intervals/0001-aaaaaaaaaaaa.json", "{}\n"],
          ["README.md", null],
        ]),
        message: "Record upstream triage: 1 port",
        sign: false,
      }),
    );

    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(git(cwd, "status", "--porcelain")).toBe(statusBefore);
    expect(git(cwd, "rev-parse", "refs/heads/f5/upstream-ledger-test")).toBe(sha);
    expect(git(cwd, "show", `${sha}:upstream/topics/2026-10.json`)).toBe('{\n  "a": 1\n}');
    expect(git(cwd, "ls-tree", "-r", "--name-only", sha).split("\n")).toEqual([
      "upstream/intervals/0001-aaaaaaaaaaaa.json",
      "upstream/topics/2026-10.json",
    ]);
    expect(git(cwd, "log", "-1", "--format=%P", sha)).toBe(head);
  });

  it("rejects a stale expected tip", async () => {
    const cwd = repo();
    write(cwd, "a.txt", "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    const head = git(cwd, "rev-parse", "HEAD");
    git(cwd, "branch", "ledger", head);
    const error = await runExit((upstream) =>
      upstream.commitFilesToBranch({
        cwd,
        branch: "ledger",
        parent: head,
        expectedTip: "1".repeat(40),
        files: new Map([["b.txt", "b\n"]]),
        message: "x",
        sign: false,
      }),
    );
    expect(String((error as Error).message ?? error)).toMatch(/update-ref/u);
    expect(git(cwd, "rev-parse", "ledger")).toBe(head);
  });

  it("signs with an SSH test key", async () => {
    const cwd = repo();
    write(cwd, "a.txt", "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    const key = path.join(cwd, "..", `${path.basename(cwd)}-key`);
    try {
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    } catch {
      return; // ssh-keygen is unavailable on this host.
    }
    directories.push(key, `${key}.pub`);
    git(cwd, "config", "gpg.format", "ssh");
    git(cwd, "config", "user.signingkey", key);
    const sha = await runWith((upstream) =>
      upstream.commitFilesToBranch({
        cwd,
        branch: "signed",
        parent: git(cwd, "rev-parse", "HEAD"),
        expectedTip: null,
        files: new Map([["b.txt", "b\n"]]),
        message: "signed ledger",
        sign: true,
      }),
    );
    expect(git(cwd, "cat-file", "-p", sha)).toContain("-----BEGIN SSH SIGNATURE-----");
  });

  it("fails fast with a bogus signing program", async () => {
    const cwd = repo();
    write(cwd, "a.txt", "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    git(cwd, "config", "gpg.program", path.join(cwd, "no-such-gpg"));
    const started = Date.now();
    const error = await runExit((upstream) =>
      upstream.commitFilesToBranch({
        cwd,
        branch: "signed",
        parent: git(cwd, "rev-parse", "HEAD"),
        expectedTip: null,
        files: new Map([["b.txt", "b\n"]]),
        message: "x",
        sign: true,
      }),
    );
    expect(error, String((error as Error).message)).toBeInstanceOf(UpstreamSigningError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills a signing program that exceeds the deadline", async () => {
    if (process.platform === "win32") return;
    const cwd = repo();
    write(cwd, "a.txt", "a\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    const program = path.join(cwd, "slow-gpg.sh");
    fs.writeFileSync(program, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    git(cwd, "config", "gpg.program", program);
    const started = Date.now();
    const error = await runExit(
      (upstream) =>
        upstream.commitFilesToBranch({
          cwd,
          branch: "signed",
          parent: git(cwd, "rev-parse", "HEAD"),
          expectedTip: null,
          files: new Map([["b.txt", "b\n"]]),
          message: "x",
          sign: true,
        }),
      { signing: 500 },
    );
    expect(error, String((error as Error).message)).toBeInstanceOf(UpstreamSigningError);
    expect(String((error as Error).message)).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("numstat and patch streams", () => {
  function fixture() {
    const cwd = repo();
    write(cwd, "base.txt", "base\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "base");
    const base = git(cwd, "rev-parse", "HEAD");
    // External diff and textconv drivers must be ignored.
    write(cwd, ".gitattributes", "*.txt diff=evil\n");
    git(cwd, "config", "diff.evil.textconv", "sh -c 'echo TEXTCONV'");
    git(cwd, "config", "diff.external", "sh -c 'echo EXTERNAL'");
    git(cwd, "add", ".gitattributes");
    git(cwd, "commit", "-m", "attributes");
    write(cwd, "src/a.txt", `${"line\n".repeat(400)}`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "big file");
    git(cwd, "mv", "src/a.txt", "src/renamed.txt");
    git(cwd, "commit", "-m", "rename");
    write(cwd, "bin.dat", Buffer.from([0, 1, 2, 3]));
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "binary");
    git(cwd, "commit", "--allow-empty", "-m", "empty");
    git(cwd, "checkout", "-q", "-b", "feature");
    write(cwd, "feature.txt", "feature\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "feature work");
    git(cwd, "checkout", "-q", "main");
    git(cwd, "merge", "--no-ff", "-q", "-m", "Merge feature", "feature");
    const head = git(cwd, "rev-parse", "HEAD");
    const shas = git(cwd, "rev-list", "--first-parent", `${base}..${head}`).split("\n");
    return { cwd, base, head, shas };
  }

  it("parses ranges and SHA lists, keeps merges, and caps excerpts", async () => {
    const { cwd, base, head, shas } = fixture();
    const subjects = new Map(
      git(cwd, "log", "--first-parent", "--format=%H %s", `${base}..${head}`)
        .split("\n")
        .map((line) => [line.slice(41), line.slice(0, 40)]),
    );
    const range = await runWith((upstream) =>
      upstream.streamNumstat(cwd, { kind: "range", from: base, to: head }),
    );
    expect(range.size).toBe(shas.length);
    expect(range.get(subjects.get("Merge feature")!)!.paths).toEqual(["feature.txt"]);
    expect(range.get(subjects.get("rename")!)!.paths).toEqual(["src/renamed.txt"]);
    expect(range.get(subjects.get("binary")!)!.files).toEqual([
      { path: "bin.dat", added: null, deleted: null },
    ]);
    expect(range.get(subjects.get("empty")!)!.totalFiles).toBe(0);
    expect(range.get(subjects.get("big file")!)!.files[0]).toEqual({
      path: "src/a.txt",
      added: 400,
      deleted: 0,
    });

    // Non-contiguous SHA list form.
    const picked = [subjects.get("binary")!, subjects.get("attributes")!];
    const list = await runWith((upstream) =>
      upstream.streamNumstat(cwd, { kind: "shas", shas: picked }),
    );
    expect([...list.keys()]).toEqual(picked);

    const patches = await runWith((upstream) =>
      upstream.streamPatches(cwd, { kind: "range", from: base, to: head }),
    );
    const big = patches.get(subjects.get("big file")!)!;
    expect(big.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(big).toContain("+line");
    for (const excerpt of patches.values()) {
      expect(excerpt).not.toContain("TEXTCONV");
      expect(excerpt).not.toContain("EXTERNAL");
    }
    expect(patches.get(subjects.get("Merge feature")!)).toContain("+feature");

    const listPatches = await runWith((upstream) =>
      upstream.streamPatches(cwd, { kind: "shas", shas: [subjects.get("big file")!] }),
    );
    expect([...listPatches.keys()]).toEqual([subjects.get("big file")!]);

    const paths = await runWith((upstream) => upstream.topicPaths(cwd, picked));
    expect(paths).toEqual(["bin.dat", ".gitattributes"]);

    const commits = await runWith((upstream) =>
      upstream.firstParentCommits({ cwd, from: base, to: head }),
    );
    expect(commits.map((commit) => commit.sha)).toEqual(shas);
    expect(commits[0]!.parents).toHaveLength(2);
  });
});

describe("readFilesAtRef", () => {
  it("reads 500 files in one batch", async () => {
    const cwd = repo();
    for (let i = 0; i < 500; i++)
      write(cwd, `upstream/topics/f${i}.json`, `{"n": ${i}, "é": "ü"}\n`);
    write(cwd, "other/skip.txt", "skip\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "many");
    const files = await runWith((upstream) =>
      upstream.readFilesAtRef({ cwd, ref: "HEAD", pathPrefixes: ["upstream/"] }),
    );
    expect(files.size).toBe(500);
    expect(files.get("upstream/topics/f42.json")).toBe('{"n": 42, "é": "ü"}\n');
    expect(files.has("other/skip.txt")).toBe(false);
  });
});
