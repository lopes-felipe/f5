import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { CheckpointStoreLiveWithGitService } from "./CheckpointStore.ts";

function makeLayer(calls: ExecuteGitInput[]) {
  return CheckpointStoreLiveWithGitService.pipe(
    Layer.provideMerge(
      Layer.succeed(GitService, {
        execute: (input) =>
          Effect.sync(() => {
            calls.push(input);
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

describe("CheckpointStoreLive", () => {
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
