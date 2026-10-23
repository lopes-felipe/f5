import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  AUTHORED_PATHS_MAX_COMMITS,
  CheckpointStoreLiveWithGitService,
  CheckpointStoreLiveWithoutCredentials,
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
  it.each([
    ["fatal: Unable to create '/tmp/index.lock': File exists", 2, 3],
    ["error: open('vanished.txt'): No such file or directory", 1, 2],
    ["fatal: Unable to create '/tmp/index.lock': File exists", 5, 4],
    ["permission denied", 1, 1],
  ] as const)("bounds retries for %s", async (detail, failures, expectedAttempts) => {
    const calls: ExecuteGitInput[] = [];
    let attempts = 0;
    const layer = CheckpointStoreLiveWithGitService.pipe(
      Layer.provide(
        Layer.succeed(GitService, {
          execute: (input) =>
            Effect.gen(function* () {
              calls.push(input);
              if (input.args.includes("add") && ++attempts <= failures) {
                return yield* new GitCommandError({
                  operation: input.operation,
                  cwd: input.cwd,
                  command: "git add",
                  detail,
                });
              }
              return { code: 0, stdout: "oid\n", stderr: "" };
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({
            cwd: "/repo",
            checkpointRef: CheckpointRef.makeUnsafe("refs/t3/test"),
          });
        }).pipe(Effect.provide(layer)),
      ),
    );
    expect(attempts).toBe(expectedAttempts);
    expect(result._tag).toBe(failures < expectedAttempts ? "Success" : "Failure");
    for (const call of calls.filter((call) =>
      ["add", "write-tree", "commit-tree", "update-ref"].some((command) =>
        call.args.includes(command),
      ),
    )) {
      expect(call.args).toContain("core.fsync=objects,reference");
      expect(call.args).toContain("core.fsyncMethod=batch");
      expect(call.env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
    }
    if (result._tag === "Failure")
      expect(calls.some((call) => call.args.includes("update-ref"))).toBe(false);
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

    async function scenario(turn: (cwd: string) => void, before?: (cwd: string) => void) {
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
                options: { excludeGitImports },
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
