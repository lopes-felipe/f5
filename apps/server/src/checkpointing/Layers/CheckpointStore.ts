import { gitConfigArgs } from "@t3tools/shared/git";
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
import { copiedIndexTimestampSeconds } from "../../git/copiedIndex.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitServiceLive } from "../../git/Layers/GitService.ts";
import { GitService, type ExecuteGitInput } from "../../git/Services/GitService.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@t3tools/contracts";
import { batchLiteralPathspecs, isGitImport, parseNumstatPaths } from "../Diffs.ts";

// Path lists are small next to patches; a bound keeps a pathological history from hanging diffs.
const AUTHORED_PATHS_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Commits either side of a HEAD move that the git-import filter replays before giving up. */
export const AUTHORED_PATHS_MAX_COMMITS = 200;
const AUTHORED_PATHS_TIMEOUT_MS = 5_000;
const AUTHORED_PATHS_CACHE_SIZE = 64;

function isSafeCheckpointRef(ref: string): boolean {
  if (!ref.startsWith("refs/") || /\s/.test(ref)) return false;
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitService;
  /** The git-import filter's answer per checkpoint pair, oldest first. */
  const authoredPathsCache = new Map<string, ReadonlyArray<ReadonlyArray<string>> | null>();

  const durableWrite = gitConfigArgs([
    ["core.fsync", "objects,reference"],
    ["core.fsyncMethod", "batch"],
  ]);
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
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${checkpointRef}^{commit}`],
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
      const indexConfig = gitConfigArgs([
        ["core.fsmonitor", "false"],
        ["sparse.expectFilesOutsideOfPatterns", "false"],
      ]);

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

            // HEAD at capture becomes the checkpoint commit's parent, so a later diff can
            // tell files a pull, merge or rebase brought in from the turn's own edits.
            const capturedHead = yield* resolveHeadCommit(input.cwd);
            const headExists = capturedHead !== null;
            const sparseResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "--", "core.sparseCheckout"],
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
                const timestamp = copiedIndexTimestampSeconds(metadata.mtime);
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
                    args: ["config", "--bool", "--", "core.sparseCheckoutCone"],
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
                    ? [
                        ...indexConfig,
                        ...gitConfigArgs([["index.sparse", "true"]]),
                        "read-tree",
                        "--reset",
                        "HEAD",
                      ]
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
            // If HEAD moved while staging, the parent would not describe this snapshot.
            // Keep the snapshot parentless; its diffs then show every changed file.
            const parent =
              capturedHead !== null && (yield* resolveHeadCommit(input.cwd)) === capturedHead
                ? ["-p", capturedHead]
                : [];
            const commitTreeResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: [...durableWrite, "commit-tree", treeOid, ...parent, "-m", message],
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
              args: [...durableWrite, "update-ref", "--", input.checkpointRef, commitOid],
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

  const readCheckpointRefs: CheckpointStoreShape["readCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const refs = new Set(input.checkpointRefs);
      if (!refs.size) return {};
      let prefix: string = input.checkpointRefs[0]!;
      for (const ref of refs) {
        if (!isSafeCheckpointRef(ref))
          return yield* new CheckpointInvariantError({
            operation: "CheckpointStore.readCheckpointRefs",
            detail: "Invalid checkpoint ref for inspection.",
          });
        while (!ref.startsWith(prefix)) prefix = prefix.slice(0, -1);
      }
      prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const result = yield* git.execute({
        operation: "CheckpointStore.readCheckpointRefs",
        cwd: input.cwd,
        args: ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix],
        maxOutputBytes: 16 * 1024 * 1024,
      });
      const resolved: Record<string, string> = {};
      for (const line of result.stdout.split("\n")) {
        const [ref, oid] = line.split("\t");
        if (!ref || !refs.has(CheckpointRef.makeUnsafe(ref))) continue;
        if (!oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid))
          return yield* new CheckpointInvariantError({
            operation: "CheckpointStore.readCheckpointRefs",
            detail: "Git returned an invalid checkpoint object id.",
          });
        resolved[ref] = oid;
      }
      return resolved;
    });

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

      // Restoring away the last tracked file removes a nested workspace directory, and on
      // Windows the clean can remove './' and still exit 0. Recreate it after each step.
      const recreateWorkspace = fs.makeDirectory(input.cwd, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointInvariantError({
              operation,
              detail: "Could not recreate the checkpoint workspace directory.",
              cause,
            }),
        ),
      );
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* recreateWorkspace;
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });
      yield* recreateWorkspace;

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

      const whitespace = input.options?.ignoreWhitespace === true ? ["--ignore-all-space"] : [];
      const patch = (pathspecs: ReadonlyArray<string>) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: [
              "diff",
              "--patch",
              "--find-renames",
              "--relative",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--minimal",
              "--no-color",
              ...whitespace,
              fromCommitOid,
              toCommitOid,
              "--",
              ...pathspecs,
            ],
          })
          .pipe(Effect.map((result) => result.stdout));

      if (input.options?.excludeGitImports !== true) return yield* patch([]);
      // Filtering is best effort: when it cannot run, the complete diff still loads. Commits
      // never change, so each pair's answer, fallback included, is kept for the next open.
      const cacheKey = JSON.stringify([input.cwd, fromCommitOid, toCommitOid, whitespace]);
      const retained = authoredPathsCache.has(cacheKey)
        ? authoredPathsCache.get(cacheKey)!
        : yield* authoredDiffPaths({ cwd: input.cwd, fromCommitOid, toCommitOid, whitespace }).pipe(
            Effect.orElseSucceed(() => null),
            Effect.tap((value) =>
              Effect.sync(() => {
                authoredPathsCache.set(cacheKey, value);
                if (authoredPathsCache.size > AUTHORED_PATHS_CACHE_SIZE)
                  authoredPathsCache.delete(authoredPathsCache.keys().next().value!);
              }),
            ),
          );
      if (retained === null) return yield* patch([]);
      // Select paths before building the patch, so imported bulk cannot exhaust its output.
      const patches = yield* Effect.forEach(
        batchLiteralPathspecs(retained),
        (pathspecs) => patch(pathspecs),
        { concurrency: 4 },
      );
      return patches.join("");
    });

  /**
   * The changed files between two checkpoints that the turn authored, or null when every
   * changed file belongs to the turn (HEAD did not move, or a checkpoint has no parent).
   * A path is authored when it differs from HEAD at either checkpoint, or a commit made
   * after the first checkpoint, or a commit that left HEAD, touched it. Remerge diffs list
   * a merge's paths only where the result differs from Git's automatic merge, so conflict
   * fixes stay and clean upstream changes drop out.
   */
  const authoredDiffPaths = (input: {
    readonly cwd: string;
    readonly fromCommitOid: string;
    readonly toCommitOid: string;
    readonly whitespace: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.authoredDiffPaths";
      const heads = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "log",
          "--no-walk=unsorted",
          "--format=%P %ct",
          input.fromCommitOid,
          input.toCommitOid,
        ],
        timeoutMs: AUTHORED_PATHS_TIMEOUT_MS,
      });
      // Each line is "<parent> <committer time>"; the parent is HEAD at capture.
      const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
      const [startHead = "", capturedAt = ""] = fromLine.split(" ");
      const [endHead = ""] = toLine.split(" ");
      if (startHead === "" || endHead === "" || startHead === endHead) return null;

      // Remerge replays every merge in a range, so a long one (a reset across a busy branch)
      // would hold the diff panel. Past the cap the whole diff is shown instead.
      const ranges = [
        [`${endHead}..${startHead}`],
        [`--since=@${capturedAt}`, `${startHead}..${endHead}`],
      ];
      const counts = yield* Effect.forEach(
        ranges,
        (range) =>
          git
            .execute({
              operation,
              cwd: input.cwd,
              args: [
                "rev-list",
                "--count",
                `--max-count=${AUTHORED_PATHS_MAX_COMMITS + 1}`,
                ...range,
              ],
              timeoutMs: AUTHORED_PATHS_TIMEOUT_MS,
            })
            .pipe(Effect.map((result) => Number(result.stdout.trim()))),
        { concurrency: "unbounded" },
      );
      if (counts.some((count) => !(count <= AUTHORED_PATHS_MAX_COMMITS))) return null;

      const listPaths = (args: ReadonlyArray<string>) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: [...args, "--relative", "--name-only", "-z", "--no-renames", "--no-ext-diff"],
            maxOutputBytes: AUTHORED_PATHS_MAX_OUTPUT_BYTES,
            timeoutMs: AUTHORED_PATHS_TIMEOUT_MS,
          })
          .pipe(Effect.map((result) => result.stdout.split("\0")));
      const [authoredLists, changed] = yield* Effect.all(
        [
          Effect.all(
            [
              listPaths(["diff", startHead, input.fromCommitOid]),
              listPaths(["diff", endHead, input.toCommitOid]),
              ...ranges.map((range) =>
                listPaths(["log", "--format=", "--diff-merges=remerge", ...range]),
              ),
            ],
            { concurrency: "unbounded" },
          ),
          git.execute({
            operation,
            cwd: input.cwd,
            args: [
              "diff",
              "--numstat",
              "-z",
              "--find-renames",
              "--relative",
              ...input.whitespace,
              input.fromCommitOid,
              input.toCommitOid,
              "--",
            ],
            maxOutputBytes: AUTHORED_PATHS_MAX_OUTPUT_BYTES,
            timeoutMs: AUTHORED_PATHS_TIMEOUT_MS,
          }),
        ],
        { concurrency: "unbounded" },
      );
      const authored = new Set(authoredLists.flat().filter((path) => path.length > 0));
      const files = parseNumstatPaths(changed.stdout);
      const retained = files.filter((file) => !isGitImport(file, authored));
      if (retained.length === files.length) return null;
      return retained.map((file) =>
        file.previousPath === undefined ? [file.path] : [file.previousPath, file.path],
      );
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      if (input.checkpointRefs.length === 0) return;
      const deletions: string[] = [];
      for (const ref of new Set(input.checkpointRefs)) {
        if (!isSafeCheckpointRef(ref))
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Invalid checkpoint ref for deletion.",
          });
        const expected = input.expectedOids?.[ref];
        if (expected !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected))
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Invalid checkpoint object id for deletion.",
          });
        deletions.push(`delete ${ref}${expected ? ` ${expected}` : ""}\n`);
      }
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", "--stdin"],
        stdin: `start\n${deletions.join("")}prepare\ncommit\n`,
      });
    });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    readCheckpointRefs,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLiveWithGitService = Layer.effect(CheckpointStore, makeCheckpointStore);

/** Credential-free test harness; production runtimes must supply their configured Git service. */
export const CheckpointStoreLiveWithoutCredentials = CheckpointStoreLiveWithGitService.pipe(
  Layer.provideMerge(GitServiceLive),
);
