/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Effect, Layer, FileSystem, Path, Schedule } from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitServiceLive } from "../../git/Layers/GitService.ts";
import { GitService, type ExecuteGitInput } from "../../git/Services/GitService.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@t3tools/contracts";

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitService;

  const durableWrite = ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=batch"];
  // Retry only capture commands with recognizable lock/file disappearance races.
  const executeCapture = (input: ExecuteGitInput) =>
    git.execute({ ...input, env: { ...input.env, LC_ALL: "C", LANGUAGE: "C" } }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("75 millis"),
        while: (error) =>
          /unable to create [^\n]*\.lock['"]?: file exists/i.test(error.detail) ||
          /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(
            error.detail,
          ),
      }),
    );

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";
      const indexConfig = [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "sparse.expectFilesOutsideOfPatterns=false",
      ];

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "t3-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "T3 Code",
              GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
              GIT_COMMITTER_NAME: "T3 Code",
              GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
            };

            const headExists = yield* hasHeadCommit(input.cwd);
            const sparseResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "core.sparseCheckout"],
              allowNonZeroExit: true,
            });
            const sparse = sparseResult.stdout.trim() === "true";
            if (headExists) {
              const reused = yield* Effect.gen(function* () {
                const source = yield* executeCapture({
                  operation,
                  cwd: input.cwd,
                  args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
                });
                const sourcePath = source.stdout.trim();
                const metadata = yield* fs.stat(sourcePath);
                if (metadata.mtime === undefined) return false;
                const timestamp = Math.floor((metadata.mtime.getTime() - 1) / 1000);
                if (timestamp <= 0) return false;
                yield* fs.copyFile(sourcePath, tempIndexPath);
                yield* executeCapture({
                  operation,
                  cwd: input.cwd,
                  args: [...indexConfig, "read-tree", "--reset", "HEAD"],
                  env: commitEnv,
                });
                // Preserve racy-index detection even when read-tree rewrites the copy.
                yield* fs.utimes(tempIndexPath, timestamp, timestamp);
                let specialFlags = false;
                let atStart = true;
                let skippedRecord = false;
                let record: number[] = [];
                let retainedBytes = 0;
                const skipped: string[] = [];
                yield* executeCapture({
                  operation,
                  cwd: input.cwd,
                  args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
                  env: commitEnv,
                  onStdoutChunk: (chunk) => {
                    for (const byte of chunk) {
                      if (atStart) {
                        skippedRecord = byte === 83 && sparse;
                        if ((byte >= 97 && byte <= 122) || (byte === 83 && !sparse))
                          specialFlags = true;
                      }
                      if (skippedRecord && !specialFlags) {
                        if (byte !== 0) {
                          record.push(byte);
                          if (++retainedBytes > 32 * 1024 * 1024) specialFlags = true;
                        } else {
                          if (record.at(-1) !== 47) {
                            try {
                              skipped.push(
                                new TextDecoder("utf-8", { fatal: true }).decode(
                                  Uint8Array.from(record).subarray(2),
                                ),
                              );
                            } catch {
                              specialFlags = true;
                            }
                          }
                          record = [];
                        }
                      }
                      atStart = byte === 0;
                    }
                  },
                });
                if (specialFlags) return false;
                if (sparse && skipped.length > 0) {
                  let hasSelected = false;
                  yield* executeCapture({
                    operation,
                    cwd: input.cwd,
                    args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                    stdin: skipped.join("\0") + "\0",
                    env: commitEnv,
                    onStdoutChunk: (chunk) => {
                      if (chunk.length > 0) hasSelected = true;
                    },
                  });
                  if (hasSelected) return false;
                }
                return true;
              }).pipe(Effect.catch(() => Effect.succeed(false)));
              if (!reused) {
                if (sparse) {
                  const cone = yield* executeCapture({
                    operation,
                    cwd: input.cwd,
                    args: ["config", "--bool", "core.sparseCheckoutCone"],
                    allowNonZeroExit: true,
                  });
                  if (cone.stdout.trim() !== "true")
                    return yield* new CheckpointInvariantError({
                      operation,
                      detail:
                        "Cannot safely rebuild a checkpoint index for non-cone sparse checkout.",
                    });
                }
                yield* fs.remove(tempIndexPath, { force: true });
                yield* executeCapture({
                  operation,
                  cwd: input.cwd,
                  args: sparse
                    ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                    : [...indexConfig, "read-tree", "HEAD"],
                  env: commitEnv,
                });
              }
            }

            const stageFiles = (exclusions: ReadonlyArray<string>) =>
              executeCapture({
                operation,
                cwd: input.cwd,
                args: [
                  ...durableWrite,
                  ...indexConfig,
                  "add",
                  ...(sparse ? ["--sparse"] : []),
                  "-A",
                  "--",
                  ".",
                  ...exclusions,
                ],
                env: commitEnv,
              });
            yield* stageFiles([]).pipe(
              Effect.catch((error) => {
                if (!/does not have a commit checked out/i.test(error.detail))
                  return Effect.fail(error);
                return Effect.gen(function* () {
                  const untracked = yield* executeCapture({
                    operation,
                    cwd: input.cwd,
                    args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                    env: commitEnv,
                    maxOutputBytes: 8 * 1024 * 1024,
                  });
                  const candidates = untracked.stdout
                    .split("\0")
                    .filter((entry) => entry.endsWith("/"));
                  if (candidates.length > 64) return yield* error;
                  const exclusions: string[] = [];
                  const nestedEnv = {
                    ...process.env,
                    GIT_DIR: undefined,
                    GIT_WORK_TREE: undefined,
                    GIT_COMMON_DIR: undefined,
                    GIT_INDEX_FILE: undefined,
                    GIT_OBJECT_DIRECTORY: undefined,
                    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                  };
                  for (const entry of candidates) {
                    const nestedCwd = path.resolve(input.cwd, entry);
                    if (!(yield* fs.exists(path.join(nestedCwd, ".git")))) continue;
                    const head = yield* executeCapture({
                      operation,
                      cwd: nestedCwd,
                      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
                      env: { ...nestedEnv, GIT_CEILING_DIRECTORIES: path.dirname(nestedCwd) },
                      allowNonZeroExit: true,
                    });
                    if (head.code === 1) exclusions.push(`:(exclude,literal)${entry}`);
                    else if (head.code !== 0) return yield* error;
                  }
                  if (exclusions.length === 0) return yield* error;
                  return exclusions;
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: "5 seconds",
                    onTimeout: () =>
                      Effect.fail(
                        new GitCommandError({
                          ...error,
                          detail: "Empty-repository discovery timed out after 5 seconds.",
                        }),
                      ),
                  }),
                  Effect.catch((cause) => {
                    if (cause === error) return Effect.fail(error);
                    return Effect.fail(
                      new GitCommandError({
                        ...error,
                        detail: `${error.detail} Recovery discovery failed: ${cause.message}`,
                        cause,
                      }),
                    );
                  }),
                  Effect.tapError((failure) =>
                    Effect.logWarning("checkpoint empty-repository discovery failed", {
                      detail: failure.message,
                    }),
                  ),
                  // Re-staging has the normal Git deadline, not the discovery budget.
                  Effect.flatMap(stageFiles),
                );
              }),
            );

            const writeTreeResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: [...durableWrite, ...indexConfig, "write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `t3 checkpoint ref=${input.checkpointRef}`;
            const commitTreeResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: [...durableWrite, "commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: [...durableWrite, "update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      let fromCommitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      const toCommitOid = yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef);

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const diffArgs = [
        "diff",
        "--patch",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--minimal",
        "--no-color",
      ];
      if (input.options?.ignoreWhitespace === true) {
        diffArgs.push("--ignore-all-space");
      }
      diffArgs.push(fromCommitOid, toCommitOid, "--");

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: diffArgs,
      });

      return result.stdout;
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      yield* Effect.forEach(
        input.checkpointRefs,
        (checkpointRef) =>
          git.execute({
            operation,
            cwd: input.cwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          }),
        { discard: true },
      );
    });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLiveWithGitService = Layer.effect(CheckpointStore, makeCheckpointStore);

export const CheckpointStoreLive = CheckpointStoreLiveWithGitService.pipe(
  Layer.provideMerge(GitServiceLive),
);
