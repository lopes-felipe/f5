import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointRef } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { Deferred, Fiber, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { GitCommandError } from "../../git/Errors.ts";
import { GitService, type ExecuteGitInput } from "../../git/Services/GitService.ts";
import { copiedIndexTimestampSeconds } from "../../git/copiedIndex.ts";
import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  checkpointWorkspaceRepositories,
  nestedCheckpointPaths,
  restoreCheckpointRepositories,
  scopedCheckpointRef,
} from "../checkpointRepositories.ts";
import {
  AUTHORED_PATHS_MAX_COMMITS,
  CheckpointStoreLiveWithGitService,
  CheckpointStoreLiveWithoutCredentials,
  makeCheckpointStoreLayer,
  parseFingerprintStatus,
} from "./CheckpointStore.ts";

function makeLayer(calls: ExecuteGitInput[], refOutput = "") {
  return CheckpointStoreLiveWithGitService.pipe(
    Layer.provideMerge(
      Layer.succeed(GitService, {
        execute: (input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.args[0] === "for-each-ref") return { code: 0, stdout: refOutput, stderr: "" };
            if (input.args[0] === "rev-parse") {
              return { code: 0, stdout: `${input.args.at(-1)}-oid\n`, stderr: "" };
            }
            return { code: 0, stdout: "diff patch", stderr: "" };
          }),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("copiedIndexTimestampSeconds", () => {
  it("keeps the index's own second, even when it falls exactly on the second", () => {
    expect(copiedIndexTimestampSeconds(new Date(1_700_000_000_000))).toBe(1_700_000_000);
    expect(copiedIndexTimestampSeconds(new Date(1_700_000_000_999))).toBe(1_700_000_000);
  });
});

describe("CheckpointStoreLive", () => {
  it("resolves thousands of exact checkpoint refs with one bounded Git listing", async () => {
    const refs = Array.from({ length: 2000 }, (_, turn) =>
      CheckpointRef.makeUnsafe(`refs/t3/checkpoints/thread/${turn}`),
    );
    const oid = "a".repeat(40);
    const calls: ExecuteGitInput[] = [];
    const layer = makeLayer(
      calls,
      [...refs.map((ref) => `${ref}\t${oid}`), `refs/t3/checkpoints/other/0\t${oid}`].join("\n"),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CheckpointStore).readCheckpointRefs({
          cwd: "/fixture",
          checkpointRefs: refs,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(Object.keys(result)).toHaveLength(2000);
    expect(result[refs[0]!]).toBe(oid);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      "refs/t3/checkpoints/thread/",
    ]);
  });
  const captureOnPlatform = (
    platform: NodeJS.Platform,
    fail: (input: ExecuteGitInput) => string | null = () => null,
  ) => {
    const calls: ExecuteGitInput[] = [];
    const layer = makeCheckpointStoreLayer(platform).pipe(
      Layer.provide(
        Layer.succeed(GitService, {
          execute: (input) =>
            Effect.gen(function* () {
              calls.push(input);
              const detail = fail(input);
              if (detail !== null) {
                return yield* new GitCommandError({
                  operation: input.operation,
                  cwd: input.cwd,
                  command: "git",
                  detail,
                });
              }
              return { code: 0, stdout: "oid\n", stderr: "" };
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    return Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          yield* (yield* CheckpointStore).captureCheckpoint({
            cwd: "/repo",
            checkpointRef: CheckpointRef.makeUnsafe("refs/t3/test"),
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).then((result) => ({ result, calls }));
  };
  const durableCalls = (calls: ReadonlyArray<ExecuteGitInput>) =>
    calls.filter((call) =>
      ["add", "write-tree", "commit-tree", "update-ref"].some((command) =>
        call.args.includes(command),
      ),
    );
  const fsyncMethods = (call: ExecuteGitInput) =>
    call.args.filter((arg) => arg.startsWith("core.fsyncMethod="));

  it.each([
    ["fatal: Unable to create '/tmp/index.lock': File exists", 2, 3],
    ["error: open('vanished.txt'): No such file or directory", 1, 2],
    ["fatal: Unable to create '/tmp/index.lock': File exists", 5, 4],
    ["permission denied", 1, 1],
  ] as const)("bounds retries for %s", async (detail, failures, expectedAttempts) => {
    let attempts = 0;
    const { result, calls } = await captureOnPlatform("linux", (input) =>
      input.args.includes("add") && ++attempts <= failures ? detail : null,
    );
    expect(attempts).toBe(expectedAttempts);
    expect(result._tag).toBe(failures < expectedAttempts ? "Success" : "Failure");
    for (const call of durableCalls(calls)) {
      expect(call.args).toContain("core.fsync=objects,reference");
      expect(call.args).toContain("core.fsyncMethod=fsync");
      expect(call.env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
    }
    if (result._tag === "Failure")
      expect(calls.some((call) => call.args.includes("update-ref"))).toBe(false);
  });

  it.each([
    ["darwin", ["core.fsyncMethod=fsync", "core.fsyncMethod=batch"]],
    ["win32", ["core.fsyncMethod=fsync", "core.fsyncMethod=batch"]],
    ["linux", ["core.fsyncMethod=fsync"]],
  ] as const)(
    "batches object flushes only where Git documents it as safe: %s",
    async (platform, expected) => {
      const { result, calls } = await captureOnPlatform(platform);
      expect(result._tag).toBe("Success");
      const durable = durableCalls(calls);
      expect(durable).toHaveLength(4);
      for (const call of durable) expect(fsyncMethods(call)).toEqual(expected);
    },
  );

  const unsupportedObjectFsync =
    "git add failed: error: fsync error on '.git/objects/ab/tmp_obj_x': Operation not supported\nfatal: adding files failed";
  const unsupportedRefFsync =
    "git update-ref failed: fatal: cannot update ref 'refs/t3/test': couldn't write '/repo/.git/refs/t3/test.lock'";

  it.each([
    ["add", unsupportedObjectFsync],
    ["update-ref", unsupportedRefFsync],
  ] as const)(
    "on macOS retries %s once with writeout-only when full fsync is unsupported",
    async (command, detail) => {
      const { result, calls } = await captureOnPlatform("darwin", (input) =>
        input.args.includes(command) && !input.args.includes("core.fsyncMethod=writeout-only")
          ? detail
          : null,
      );
      const attempts = calls.filter((call) => call.args.includes(command));
      expect(result._tag).toBe("Success");
      expect(attempts).toHaveLength(2);
      expect(fsyncMethods(attempts[1]!)).toEqual([
        "core.fsyncMethod=writeout-only",
        "core.fsyncMethod=writeout-only",
      ]);
      expect(attempts[1]!.args.filter((arg) => !arg.startsWith("core.fsyncMethod="))).toEqual(
        attempts[0]!.args.filter((arg) => !arg.startsWith("core.fsyncMethod=")),
      );
      expect(attempts[1]!.env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
    },
  );

  it("does not weaken fsync outside macOS", async () => {
    const { result, calls } = await captureOnPlatform("win32", (input) =>
      input.args.includes("add") ? unsupportedObjectFsync : null,
    );
    expect(result._tag).toBe("Failure");
    const attempts = calls.filter((call) => call.args.includes("add"));
    expect(attempts).toHaveLength(1);
    expect(fsyncMethods(attempts[0]!)).toEqual([
      "core.fsyncMethod=fsync",
      "core.fsyncMethod=batch",
    ]);
  });

  it("restarts from the full flush when the macOS fallback hits a lock race", async () => {
    let fallbacks = 0;
    const { result, calls } = await captureOnPlatform("darwin", (input) => {
      if (!input.args.includes("add")) return null;
      if (!input.args.includes("core.fsyncMethod=writeout-only")) return unsupportedObjectFsync;
      return ++fallbacks === 1
        ? "git add failed: fatal: Unable to create '/repo/.git/index.lock': File exists."
        : null;
    });
    expect(result._tag).toBe("Success");
    expect(
      calls.filter((call) => call.args.includes("add")).map((call) => fsyncMethods(call)[0]),
    ).toEqual([
      "core.fsyncMethod=fsync",
      "core.fsyncMethod=writeout-only",
      "core.fsyncMethod=fsync",
      "core.fsyncMethod=writeout-only",
    ]);
  });

  it("keeps unrelated macOS capture errors and failed fallbacks as failures", async () => {
    const unrelated = await captureOnPlatform("darwin", (input) =>
      input.args.includes("add") ? "git add failed: fatal: permission denied" : null,
    );
    expect(unrelated.result._tag).toBe("Failure");
    expect(unrelated.calls.filter((call) => call.args.includes("add"))).toHaveLength(1);

    const fallbackFails = await captureOnPlatform("darwin", (input) =>
      input.args.includes("add") ? unsupportedObjectFsync : null,
    );
    expect(fallbackFails.result._tag).toBe("Failure");
    expect(fallbackFails.calls.filter((call) => call.args.includes("add"))).toHaveLength(2);
    expect(fallbackFails.calls.some((call) => call.args.includes("update-ref"))).toBe(false);
  });

  for (const scenario of ["too-many-candidates", "discovery-timeout", "discovery-failure"])
    effectIt.effect(`bounds empty-repository recovery: ${scenario}`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const calls: ExecuteGitInput[] = [];
        const stagingError = new GitCommandError({
          operation: "capture",
          cwd: "/repo",
          command: "git add",
          detail: "error: 'empty/' does not have a commit checked out",
        });
        const layer = CheckpointStoreLiveWithGitService.pipe(
          Layer.provide(
            Layer.succeed(GitService, {
              execute: (input) =>
                Effect.gen(function* () {
                  calls.push(input);
                  if (input.args.includes("add")) return yield* stagingError;
                  if (input.args.includes("ls-files")) {
                    if (scenario === "discovery-timeout") {
                      yield* Deferred.succeed(started, undefined);
                      return yield* Effect.never;
                    }
                    if (scenario === "discovery-failure")
                      return yield* new GitCommandError({
                        operation: "discovery",
                        cwd: "/repo",
                        command: "git ls-files",
                        detail: "output exceeded limit",
                      });
                    return {
                      code: 0,
                      stdout: Array.from({ length: 65 }, (_, index) => `nested-${index}/\0`).join(
                        "",
                      ),
                      stderr: "",
                    };
                  }
                  return { code: 0, stdout: "oid\n", stderr: "" };
                }),
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const fiber = yield* Effect.result(
          Effect.gen(function* () {
            const store = yield* CheckpointStore;
            yield* store.captureCheckpoint({
              cwd: "/repo",
              checkpointRef: CheckpointRef.makeUnsafe("refs/t3/test"),
            });
          }).pipe(Effect.provide(layer)),
        ).pipe(Effect.forkChild);
        if (scenario === "discovery-timeout") {
          yield* Deferred.await(started);
          yield* TestClock.adjust("5 seconds");
        }
        const result = yield* Fiber.join(fiber);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain(stagingError.detail);
          if (scenario === "discovery-failure")
            expect(result.failure.message).toContain("output exceeded limit");
          if (scenario === "discovery-timeout")
            expect(result.failure.message).toContain("timed out");
        }
        expect(calls.some((call) => call.args.includes("update-ref"))).toBe(false);
        expect(calls.some((call) => call.cwd !== "/repo")).toBe(false);
        const temporaryIndex = calls.find((call) => call.env?.GIT_INDEX_FILE)?.env?.GIT_INDEX_FILE;
        expect(temporaryIndex).toBeDefined();
        expect(existsSync(temporaryIndex!)).toBe(false);
      }),
    );

  effectIt.effect(
    "retries re-staging outside the discovery deadline and isolates nested Git discovery",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(path.join(os.tmpdir(), "f5-restage-"));
        mkdirSync(path.join(cwd, "empty", ".git"), { recursive: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(cwd, { recursive: true, force: true })),
        );
        const sleeping = yield* Deferred.make<void>();
        const retrying = yield* Deferred.make<void>();
        let attempts = 0;
        const calls: ExecuteGitInput[] = [];
        const layer = CheckpointStoreLiveWithGitService.pipe(
          Layer.provide(
            Layer.succeed(GitService, {
              execute: (input) =>
                Effect.gen(function* () {
                  calls.push(input);
                  if (input.args.includes("add")) {
                    attempts++;
                    if (attempts < 3) {
                      if (attempts === 2) yield* Deferred.succeed(retrying, undefined);
                      return yield* new GitCommandError({
                        operation: "capture",
                        cwd,
                        command: "git add",
                        detail:
                          attempts === 1
                            ? "'empty/' does not have a commit checked out"
                            : "Unable to create index.lock: File exists",
                      });
                    }
                    yield* Deferred.succeed(sleeping, undefined);
                    yield* Effect.sleep("6 seconds");
                  }
                  if (input.args.includes("ls-files"))
                    return { code: 0, stdout: "empty/\0", stderr: "" };
                  if (input.cwd !== cwd) {
                    expect(input.env).toMatchObject({
                      LC_ALL: "C",
                      LANGUAGE: "C",
                      GIT_CEILING_DIRECTORIES: cwd,
                    });
                    return { code: 1, stdout: "", stderr: "" };
                  }
                  return { code: 0, stdout: "oid\n", stderr: "" };
                }),
            }),
          ),
          Layer.provide(NodeServices.layer),
        );
        const fiber = yield* Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({
            cwd,
            checkpointRef: CheckpointRef.makeUnsafe("refs/t3/test"),
          });
        }).pipe(Effect.provide(layer), Effect.forkChild);
        yield* Deferred.await(retrying);
        yield* TestClock.adjust("75 millis");
        yield* Deferred.await(sleeping);
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(fiber);
        expect(attempts).toBe(3);
        expect(calls.some((call) => call.args.includes("update-ref"))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it("passes exactly the ignore-all-space flag when whitespace ignoring is enabled", async () => {
    const calls: ExecuteGitInput[] = [];
    const layer = makeLayer(calls);

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.diffCheckpoints({
          cwd: "/repo",
          fromCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/0"),
          toCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/1"),
          options: { ignoreWhitespace: true },
        });
      }).pipe(Effect.provide(layer)),
    );

    const diffCall = calls.find((call) => call.args[0] === "diff");
    expect(diffCall?.args).toContain("--ignore-all-space");
    expect(diffCall?.args).not.toContain("--ignore-blank-lines");
    expect(diffCall?.args).not.toContain("--ignore-space-change");
  });

  it.each([
    [undefined, true],
    [false, false],
  ] as const)("minimizes the patch only when wanted (minimal=%s)", async (minimal, expected) => {
    const calls: ExecuteGitInput[] = [];
    const layer = makeLayer(calls);

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.diffCheckpoints({
          cwd: "/repo",
          fromCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/0"),
          toCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/1"),
          ...(minimal === undefined ? {} : { options: { minimal } }),
        });
      }).pipe(Effect.provide(layer)),
    );

    const diffCall = calls.find((call) => call.args[0] === "diff");
    expect(diffCall?.args.includes("--minimal")).toBe(expected);
  });

  describe("excluding files Git brought in", () => {
    // Fixture commits predate the captures, as commits a pull brings in do.
    const pastDate = "2020-01-01T00:00:00Z";
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_AUTHOR_DATE: pastDate, GIT_COMMITTER_DATE: pastDate },
      });
    const changedFiles = (diff: string) =>
      [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);

    async function scenario(
      turn: (cwd: string) => void,
      before?: (cwd: string) => void,
      repositoryPath?: string,
    ) {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-imports-"));
      try {
        run(cwd, "init", "-q", "-b", "main");
        run(cwd, "config", "user.email", "test@example.com");
        run(cwd, "config", "user.name", "Test");
        writeFileSync(path.join(cwd, "mine.txt"), "one\n");
        run(cwd, "add", ".");
        run(cwd, "commit", "-q", "-m", "base");
        run(cwd, "checkout", "-q", "-b", "upstream");
        writeFileSync(path.join(cwd, "upstream.txt"), "from upstream\n");
        run(cwd, "add", ".");
        run(cwd, "commit", "-q", "-m", "upstream work");
        run(cwd, "checkout", "-q", "main");
        before?.(cwd);

        const from = CheckpointRef.makeUnsafe("refs/t3/checkpoints/imports/0");
        const to = CheckpointRef.makeUnsafe("refs/t3/checkpoints/imports/1");
        return await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* CheckpointStore;
            yield* store.captureCheckpoint({ cwd, checkpointRef: from });
            turn(cwd);
            yield* store.captureCheckpoint({ cwd, checkpointRef: to });
            const diff = (excludeGitImports: boolean) =>
              store.diffCheckpoints({
                cwd,
                fromCheckpointRef: from,
                toCheckpointRef: to,
                options: { excludeGitImports, ...(repositoryPath ? { repositoryPath } : {}) },
              });
            return { filtered: yield* diff(true), full: yield* diff(false) };
          }).pipe(
            Effect.provide(
              CheckpointStoreLiveWithoutCredentials.pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }

    it("qualifies identically named files by repository in a combined turn patch", async () => {
      const edit = (cwd: string) => writeFileSync(path.join(cwd, "mine.txt"), "two\n");
      const api = await scenario(edit, undefined, "api");
      const web = await scenario(edit, undefined, "packages/web");
      expect(changedFiles(api.filtered + web.filtered)).toEqual([
        "api/mine.txt",
        "packages/web/mine.txt",
      ]);
    });

    it("leaves out files a pull brought in and keeps the turn's own edits", async () => {
      const { filtered, full } = await scenario((cwd) => {
        writeFileSync(path.join(cwd, "mine.txt"), "two\n");
        run(cwd, "merge", "-q", "--ff-only", "upstream");
      });
      expect(changedFiles(full)).toEqual(["mine.txt", "upstream.txt"]);
      expect(changedFiles(filtered)).toEqual(["mine.txt"]);
      expect(filtered).toContain("+two");
    });

    it("shows the whole diff instead of replaying a long range HEAD left", async () => {
      const { filtered, full } = await scenario(
        (cwd) => {
          // Leaving the busy branch for upstream makes HEAD leave every busy commit.
          run(cwd, "checkout", "-q", "main");
          run(cwd, "merge", "-q", "--ff-only", "upstream");
        },
        (cwd) => {
          // More commits than the filter replays, in one fast-import instead of a Git per commit.
          const base = run(cwd, "rev-parse", "HEAD").trim();
          const commits = Array.from(
            { length: AUTHORED_PATHS_MAX_COMMITS + 1 },
            (_, index) =>
              `commit refs/heads/busy\ncommitter Test <test@example.com> 1577836800 +0000\ndata 1\n${index % 10}\n${index === 0 ? `from ${base}\n` : ""}M 644 inline busy.txt\ndata ${String(index).length}\n${index}\n`,
          );
          execFileSync("git", ["fast-import", "--quiet"], { cwd, input: commits.join("") });
          run(cwd, "checkout", "-q", "busy");
        },
      );
      // Within the cap, upstream.txt would be left out as brought in by the merge.
      expect(changedFiles(full)).toContain("upstream.txt");
      expect(changedFiles(filtered)).toEqual(changedFiles(full));
    });

    it("keeps an imported file the turn also edited", async () => {
      const { filtered } = await scenario((cwd) => {
        run(cwd, "merge", "-q", "--ff-only", "upstream");
        writeFileSync(path.join(cwd, "upstream.txt"), "edited by the turn\n");
      });
      expect(changedFiles(filtered)).toEqual(["upstream.txt"]);
    });

    it("keeps linked checkout snapshots distinct and skips a repository without a baseline", async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "f5-scopes-"));
      try {
        const main = path.join(root, "main");
        const linked = path.join(main, "linked");
        const missing = path.join(main, "missing");
        mkdirSync(main);
        run(main, "init", "-q", "-b", "main");
        run(main, "config", "user.email", "test@example.com");
        run(main, "config", "user.name", "Test");
        writeFileSync(path.join(main, "file.txt"), "original\n");
        run(main, "add", "file.txt");
        run(main, "commit", "-qm", "base");
        run(main, "worktree", "add", "-qb", "linked", linked);
        run(main, "worktree", "add", "-qb", "missing", missing);
        writeFileSync(path.join(main, "file.txt"), "root baseline\n");
        writeFileSync(path.join(linked, "file.txt"), "linked baseline\n");
        const external = { path: root, relativePath: "external", externalSource: root };
        const repositories = checkpointWorkspaceRepositories([
          { path: main, relativePath: "." },
          { path: linked, relativePath: "linked" },
          { path: missing, relativePath: "missing" },
          external,
        ]);
        expect(repositories).toHaveLength(3);
        const ref = CheckpointRef.makeUnsafe("refs/t3/checkpoints/multi/turn/0");
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* CheckpointStore;
            yield* Effect.forEach(
              repositories.slice(0, 2),
              (repository) =>
                store.captureCheckpoint({
                  cwd: repository.path,
                  checkpointRef: scopedCheckpointRef(ref, repository),
                  excludePaths: nestedCheckpointPaths(repository, repositories, "capture"),
                }),
              { concurrency: 2 },
            );
            expect(run(main, "show", ref + ":file.txt")).toBe("root baseline\n");
            expect(run(main, "ls-tree", "--name-only", ref)).toBe("file.txt\n");
            for (const repository of repositories)
              writeFileSync(path.join(repository.path, "file.txt"), "edit\n");
            expect(yield* restoreCheckpointRepositories(store, repositories, ref, true)).toEqual({
              restored: true,
              skipped: [repositories[2]],
            });
          }).pipe(
            Effect.provide(
              CheckpointStoreLiveWithoutCredentials.pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
        );
        expect(readFileSync(path.join(main, "file.txt"), "utf8")).toBe("root baseline\n");
        expect(readFileSync(path.join(linked, "file.txt"), "utf8")).toBe("linked baseline\n");
        expect(readFileSync(path.join(missing, "file.txt"), "utf8")).toBe("edit\n");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("captures the submodule pin in the parent and file edits in the submodule", async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "f5-pins-"));
      try {
        const main = path.join(root, "main");
        const source = path.join(root, "source");
        for (const cwd of [main, source]) {
          mkdirSync(cwd);
          run(cwd, "init", "-q", "-b", "main");
          run(cwd, "config", "user.email", "test@example.com");
          run(cwd, "config", "user.name", "Test");
          writeFileSync(path.join(cwd, "file.txt"), "base\n");
          run(cwd, "add", "file.txt");
          run(cwd, "commit", "-qm", "base");
        }
        run(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
        run(main, "commit", "-qm", "add submodule");
        const module = path.join(main, "module");
        run(module, "config", "user.email", "test@example.com");
        run(module, "config", "user.name", "Test");
        const parent = { path: main, relativePath: "." };
        const child = { path: module, relativePath: "module", submodule: true } as const;
        const repositories = [parent, child];
        const from = CheckpointRef.makeUnsafe("refs/t3/checkpoints/multi/turn/0");
        const to = CheckpointRef.makeUnsafe("refs/t3/checkpoints/multi/turn/1");
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* CheckpointStore;
            const capture = (ref: CheckpointRef) =>
              Effect.forEach(repositories, (repository) =>
                store.captureCheckpoint({
                  cwd: repository.path,
                  checkpointRef: scopedCheckpointRef(ref, repository),
                  excludePaths: nestedCheckpointPaths(repository, repositories, "capture"),
                }),
              );
            yield* capture(from);
            writeFileSync(path.join(module, "file.txt"), "new pin\n");
            run(module, "commit", "-qam", "change pin");
            run(main, "add", "module");
            writeFileSync(path.join(module, "file.txt"), "local edit\n");
            yield* capture(to);
            const parentDiff = yield* store.diffCheckpoints({
              cwd: main,
              fromCheckpointRef: from,
              toCheckpointRef: to,
            });
            expect(parentDiff).toContain("+Subproject commit");
            const childDiff = yield* store.diffCheckpoints({
              cwd: module,
              fromCheckpointRef: scopedCheckpointRef(from, child),
              toCheckpointRef: scopedCheckpointRef(to, child),
            });
            expect(childDiff).toContain("+local edit");
          }).pipe(
            Effect.provide(
              CheckpointStoreLiveWithoutCredentials.pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps a nested workspace when restoring removes its last tracked file", async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-nested-"));
      try {
        run(root, "init", "-q", "-b", "main");
        run(root, "config", "user.email", "test@example.com");
        run(root, "config", "user.name", "Test");
        writeFileSync(path.join(root, "root.txt"), "root\n");
        run(root, "add", ".");
        run(root, "commit", "-q", "-m", "base");
        const cwd = path.join(root, "pkg");
        mkdirSync(cwd);
        const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/nested/0");
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* CheckpointStore;
            yield* store.captureCheckpoint({ cwd, checkpointRef });
            writeFileSync(path.join(cwd, "added.txt"), "added\n");
            run(cwd, "add", "added.txt");
            yield* store.restoreCheckpoint({ cwd, checkpointRef });
          }).pipe(
            Effect.provide(
              CheckpointStoreLiveWithoutCredentials.pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          ),
        );
        expect(existsSync(cwd)).toBe(true);
        expect(existsSync(path.join(cwd, "added.txt"))).toBe(false);
        expect(existsSync(path.join(root, "root.txt"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps every file when HEAD did not move", async () => {
      const { filtered, full } = await scenario((cwd) => {
        writeFileSync(path.join(cwd, "mine.txt"), "two\n");
        writeFileSync(path.join(cwd, "new.txt"), "new\n");
      });
      expect(filtered).toBe(full);
      expect(changedFiles(filtered)).toEqual(["mine.txt", "new.txt"]);
    });
  });

  it("captures untracked files without expiring the repository's shared split index", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-split-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(path.join(cwd, "file.txt"), "base\n");
      git("add", "file.txt");
      git("commit", "-q", "-m", "base");
      writeFileSync(path.join(cwd, "file.txt"), "staged\n");
      git("add", "file.txt");
      git("config", "core.splitIndex", "true");
      git("config", "splitIndex.sharedIndexExpire", "now");
      git("update-index", "--split-index");
      writeFileSync(path.join(cwd, "untracked.txt"), "new\n");
      const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/split/0");
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* CheckpointStore).captureCheckpoint({ cwd, checkpointRef });
        }).pipe(
          Effect.provide(
            CheckpointStoreLiveWithoutCredentials.pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      );
      expect(git("show", `${checkpointRef}:untracked.txt`)).toBe("new\n");
      expect(git("ls-files", "--cached")).toBe("file.txt\n");
      expect(git("diff", "--cached", "--name-only")).toBe("file.txt\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  describe("a workspace its parent repository ignores", () => {
    const liveStore = CheckpointStoreLiveWithoutCredentials.pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const makeRepository = (options?: { readonly unborn?: boolean }) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-ignored-"));
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(path.join(root, "file.txt"), "base\n");
      git("add", ".");
      if (!options?.unborn) git("commit", "-q", "-m", "base");
      return { root, git };
    };
    const capture = (cwd: string, checkpointRef: CheckpointRef) =>
      Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            yield* (yield* CheckpointStore).captureCheckpoint({ cwd, checkpointRef });
          }).pipe(Effect.provide(liveStore)),
        ),
      );

    it.each([
      { staged: true, expected: "Success" },
      { staged: false, expected: "CheckpointUnsupportedError" },
    ])(
      "before the first commit, staged=$staged captures only staged files or reports unsupported",
      async ({ staged, expected }) => {
        const { root, git } = makeRepository({ unborn: true });
        try {
          const cwd = path.join(root, "sub");
          mkdirSync(cwd);
          if (staged) {
            writeFileSync(path.join(cwd, "staged.txt"), "staged\n");
            git("add", "sub/staged.txt");
          }
          writeFileSync(path.join(root, ".gitignore"), "sub/\n");
          if (staged) writeFileSync(path.join(cwd, "staged.txt"), "staged working\n");
          writeFileSync(path.join(cwd, "secret.txt"), "private\n");
          const originalIndex = readFileSync(path.join(root, ".git", "index"));
          const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/unborn/0");

          const captured = await capture(cwd, checkpointRef);

          expect(captured._tag === "Success" ? "Success" : captured.failure._tag).toBe(expected);
          expect(readFileSync(path.join(root, ".git", "index"))).toEqual(originalIndex);
          if (staged) {
            // file.txt is staged outside the workspace, so it stays out.
            expect(git("ls-tree", "-r", "--name-only", checkpointRef)).toBe("sub/staged.txt\n");
            expect(git("show", `${checkpointRef}:sub/staged.txt`)).toBe("staged working\n");
          } else {
            expect(git("for-each-ref", "--format=%(refname)", checkpointRef)).toBe("");
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );

    it("reports unsupported before copying or rebuilding the index", async () => {
      const calls: ExecuteGitInput[] = [];
      const layer = CheckpointStoreLiveWithGitService.pipe(
        Layer.provide(
          Layer.succeed(GitService, {
            execute: (input) =>
              Effect.sync(() => {
                calls.push(input);
                if (input.args[0] === "check-ignore") return { code: 0, stdout: ".\n", stderr: "" };
                if (input.args.includes("HEAD^{commit}"))
                  return { code: 0, stdout: "head-oid\n", stderr: "" };
                if (input.args.includes("head-oid:./")) return { code: 1, stdout: "", stderr: "" };
                return { code: 0, stdout: "", stderr: "" };
              }),
          }),
        ),
        Layer.provide(NodeServices.layer),
      );
      const result = await Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            yield* (yield* CheckpointStore).captureCheckpoint({
              cwd: "/repo/ignored",
              checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/ignored/0"),
            });
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(result._tag === "Failure" && result.failure._tag).toBe("CheckpointUnsupportedError");
      // Git exits before reading stdin outside a repository; a late write raised EPIPE.
      expect(calls.find((call) => call.args[0] === "check-ignore")?.stdin).toBeUndefined();
      for (const command of ["read-tree", "ls-files", "add", "write-tree"]) {
        expect(calls.some((call) => call.args.includes(command))).toBe(false);
      }
    });

    it("reports unsupported while its allowed sibling still captures", async () => {
      const { root, git } = makeRepository();
      try {
        writeFileSync(
          path.join(root, ".gitignore"),
          "*\n!.gitignore\n!file.txt\n!keep/\n!keep/**\n",
        );
        mkdirSync(path.join(root, "ignored"));
        mkdirSync(path.join(root, "keep"));
        writeFileSync(path.join(root, "ignored", "secret.txt"), "private\n");
        writeFileSync(path.join(root, "keep", "new.txt"), "new\n");
        const originalIndex = readFileSync(path.join(root, ".git", "index"));
        const ignoredRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/ignored/0");
        const keepRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/keep/0");

        const ignored = await capture(path.join(root, "ignored"), ignoredRef);
        const kept = await capture(path.join(root, "keep"), keepRef);

        expect(ignored._tag === "Failure" && ignored.failure._tag).toBe(
          "CheckpointUnsupportedError",
        );
        expect(kept._tag).toBe("Success");
        expect(git("show", `${keepRef}:keep/new.txt`)).toBe("new\n");
        expect(git("ls-tree", "-r", keepRef, "--", "ignored")).toBe("");
        expect(git("for-each-ref", "--format=%(refname)", ignoredRef)).toBe("");
        expect(readFileSync(path.join(root, ".git", "index"))).toEqual(originalIndex);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      { tracking: "committed-only", committed: ["committed.txt"], staged: [] },
      { tracking: "staged-only", committed: [], staged: ["staged.txt"] },
      { tracking: "mixed", committed: ["committed.txt"], staged: ["staged.txt"] },
    ])("keeps $tracking tracked edits but leaves out new files", async ({ committed, staged }) => {
      const { root, git } = makeRepository();
      try {
        const cwd = path.join(root, "sub");
        mkdirSync(cwd);
        for (const file of committed) {
          writeFileSync(path.join(cwd, file), "committed\n");
          git("add", `sub/${file}`);
        }
        if (committed.length > 0) git("commit", "-q", "-m", "track project");
        for (const file of staged) {
          writeFileSync(path.join(cwd, file), "staged\n");
          git("add", `sub/${file}`);
        }
        // An unrelated staged addition must not leak into the workspace checkpoint.
        writeFileSync(path.join(root, "unrelated.txt"), "unrelated\n");
        git("add", "unrelated.txt");
        const tracked = [...committed, ...staged];
        writeFileSync(path.join(root, ".gitignore"), "sub/\n");
        for (const file of tracked) writeFileSync(path.join(cwd, file), `${file} working\n`);
        writeFileSync(path.join(cwd, "secret.txt"), "private\n");
        const originalIndex = readFileSync(path.join(root, ".git", "index"));
        const checkpointRef = CheckpointRef.makeUnsafe("refs/t3/checkpoints/sub/0");

        const captured = await capture(cwd, checkpointRef);

        expect(captured._tag).toBe("Success");
        expect(readFileSync(path.join(root, ".git", "index"))).toEqual(originalIndex);
        expect(git("ls-tree", "-r", "--name-only", checkpointRef)).toBe(
          ["file.txt", ...tracked.map((file) => `sub/${file}`)].join("\n") + "\n",
        );
        for (const file of tracked) {
          expect(git("show", `${checkpointRef}:sub/${file}`)).toBe(`${file} working\n`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("omits whitespace flags by default", async () => {
    const calls: ExecuteGitInput[] = [];
    const layer = makeLayer(calls);

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.diffCheckpoints({
          cwd: "/repo",
          fromCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/0"),
          toCheckpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread/1"),
        });
      }).pipe(Effect.provide(layer)),
    );

    const diffCall = calls.find((call) => call.args[0] === "diff");
    expect(diffCall?.args).not.toContain("--ignore-all-space");
    expect(diffCall?.args).not.toContain("--ignore-blank-lines");
    expect(diffCall?.args).not.toContain("--ignore-space-change");
  });
});

describe("unchanged-workspace fingerprints", () => {
  const liveStore = CheckpointStoreLiveWithoutCredentials.pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const run = <A>(
    effect: (store: typeof CheckpointStore.Service) => Effect.Effect<A, CheckpointStoreError>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* effect(yield* CheckpointStore);
      }).pipe(Effect.provide(liveStore)),
    );
  const withRepo = async (
    body: (repo: {
      readonly cwd: string;
      readonly git: (...args: string[]) => string;
      readonly write: (file: string, content: string) => void;
    }) => Promise<void>,
    options?: { readonly unborn?: boolean },
  ) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "f5-checkpoint-fingerprint-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), content);
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      write("tracked.txt", "base\n");
      write("dir/other.txt", "other\n");
      git("add", ".");
      if (!options?.unborn) git("commit", "-q", "-m", "base");
      await body({ cwd, git, write });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
  const fingerprint = (cwd: string, excludePaths?: ReadonlyArray<string>) =>
    run((store) => store.fingerprintWorkspace({ cwd, ...(excludePaths ? { excludePaths } : {}) }));

  it("is stable for an unchanged workspace and changes with every capturable edit", async () => {
    await withRepo(async ({ cwd, git, write }) => {
      const clean = await fingerprint(cwd);
      expect(clean).toMatch(/^[a-f0-9]{64}$/);
      expect(await fingerprint(cwd)).toBe(clean);

      write("tracked.txt", "edited\n");
      const dirty = await fingerprint(cwd);
      expect(dirty).not.toBe(clean);
      expect(await fingerprint(cwd)).toBe(dirty);

      // Same status line, new content: only the file's stat tells them apart.
      write("tracked.txt", "edited again\n");
      const dirtyAgain = await fingerprint(cwd);
      expect(dirtyAgain).not.toBe(dirty);

      write("new.txt", "new\n");
      const untracked = await fingerprint(cwd);
      expect(untracked).not.toBe(dirtyAgain);
      rmSync(path.join(cwd, "new.txt"));
      expect(await fingerprint(cwd)).toBe(dirtyAgain);

      git("commit", "-q", "-am", "move head");
      const moved = await fingerprint(cwd);
      expect(moved).not.toBe(dirtyAgain);
      expect(moved).not.toBe(clean);

      expect(await fingerprint(cwd, ["dir"])).not.toBe(moved);
    });
  });

  it("refuses workspaces whose listing cannot describe a capture", async () => {
    await withRepo(async ({ cwd, write }) => {
      write("untracked-dir/deep/file.txt", "x\n");
      expect(await fingerprint(cwd)).toBeNull();
    });
    await withRepo(
      async ({ cwd }) => {
        expect(await fingerprint(cwd)).toBeNull();
      },
      { unborn: true },
    );
    await withRepo(async ({ cwd, git, write }) => {
      git("switch", "-q", "-c", "other");
      write("tracked.txt", "other\n");
      git("commit", "-q", "-am", "other");
      git("switch", "-q", "main");
      write("tracked.txt", "main\n");
      git("commit", "-q", "-am", "main");
      try {
        git("merge", "-q", "other");
      } catch {
        // The conflict is the point.
      }
      expect(await fingerprint(cwd)).toBeNull();
    });
  });

  it("parses renames and rejects submodule entries", () => {
    const head = "a".repeat(40);
    const oid = "b".repeat(40);
    const renamed = `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new name.txt`;
    expect(
      parseFingerprintStatus(`# branch.oid ${head}\0# branch.head main\0${renamed}\0old.txt\0`),
    ).toEqual({ head, records: [`${renamed}\0old.txt`], paths: ["new name.txt", "old.txt"] });
    expect(
      parseFingerprintStatus(
        `# branch.oid ${head}\0` + `1 .M SC.. 160000 160000 160000 ${oid} ${oid} module\0`,
      ),
    ).toBeNull();
    expect(parseFingerprintStatus("# branch.oid (initial)\0")).toBeNull();
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "never lets a fingerprint stand in for edits hidden by %s",
    async (flag) => {
      await withRepo(async ({ cwd, git, write }) => {
        const first = CheckpointRef.makeUnsafe("refs/t3/checkpoints/flags/0");
        const second = CheckpointRef.makeUnsafe("refs/t3/checkpoints/flags/1");
        const before = await fingerprint(cwd);
        expect(
          (await run((store) => store.captureCheckpoint({ cwd, checkpointRef: first }))).reusable,
        ).toBe(true);

        // Flagging a file between turns rewrites the index, so the fingerprint moves even
        // though `git status` no longer reports the hidden edit.
        git("update-index", flag, "tracked.txt");
        write("tracked.txt", "hidden edit\n");
        expect(git("status", "--porcelain")).toBe("");
        expect(await fingerprint(cwd)).not.toBe(before);

        const captured = await run((store) =>
          store.captureCheckpoint({ cwd, checkpointRef: second }),
        );
        expect(captured.reusable).toBe(false);
        expect(git("show", `${second}:tracked.txt`)).toBe("hidden edit\n");
      });
    },
  );

  it("refuses a commit that does not match the workspace it is confirmed against", async () => {
    await withRepo(async ({ cwd, write }) => {
      const clean = await fingerprint(cwd);
      // An edit made while the capture ran and undone before the next listing.
      write("tracked.txt", "transient\n");
      const transient = await run((store) =>
        store.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/transient/0"),
        }),
      );
      write("tracked.txt", "base\n");
      expect(await fingerprint(cwd)).toBe(clean);
      await expect(
        run((store) => store.fingerprintWorkspace({ cwd, commitOid: transient.commitOid })),
      ).resolves.toBeNull();

      write("new.txt", "new\n");
      const settled = await run((store) =>
        store.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/transient/1"),
        }),
      );
      await expect(
        run((store) => store.fingerprintWorkspace({ cwd, commitOid: settled.commitOid })),
      ).resolves.toBe(await fingerprint(cwd));
    });
  });

  it("does not run an fsmonitor hook script named in the repository config", async () => {
    await withRepo(async ({ cwd, git }) => {
      const marker = path.join(cwd, "..", `${path.basename(cwd)}-hook-ran`);
      const hook = path.join(cwd, ".git", "fsmonitor-hook.sh");
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
      git("config", "core.fsmonitor", hook);
      try {
        expect(await fingerprint(cwd)).toMatch(/^[a-f0-9]{64}$/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(marker, { force: true });
      }
    });
  });

  it("reuses a checkpoint commit only while its source ref is unchanged", async () => {
    await withRepo(async ({ cwd, git, write }) => {
      const source = CheckpointRef.makeUnsafe("refs/t3/checkpoints/reuse/0");
      const target = CheckpointRef.makeUnsafe("refs/t3/checkpoints/reuse/1");
      const captured = await run((store) =>
        store.captureCheckpoint({ cwd, checkpointRef: source }),
      );
      expect(captured.reusable).toBe(true);
      expect(captured.commitOid).toBe(git("rev-parse", source).trim());

      const reused = await run((store) =>
        store.reuseCheckpoint({
          cwd,
          sourceRef: source,
          sourceOid: captured.commitOid,
          targetRef: target,
        }),
      );
      expect(reused).toBe(true);
      expect(git("rev-parse", target).trim()).toBe(captured.commitOid);

      write("tracked.txt", "moved\n");
      await run((store) => store.captureCheckpoint({ cwd, checkpointRef: source }));
      const stale = CheckpointRef.makeUnsafe("refs/t3/checkpoints/reuse/2");
      const refused = await run((store) =>
        store.reuseCheckpoint({
          cwd,
          sourceRef: source,
          sourceOid: captured.commitOid,
          targetRef: stale,
        }),
      );
      expect(refused).toBe(false);
      expect(git("for-each-ref", "--format=%(refname)", stale)).toBe("");
    });
  });
});
