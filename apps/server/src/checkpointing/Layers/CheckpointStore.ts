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
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";

import { Effect, Layer, FileSystem, Path, Schedule } from "effect";

import { CheckpointInvariantError, CheckpointUnsupportedError } from "../Errors.ts";
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

const FINGERPRINT_MAX_OUTPUT_BYTES = 1024 * 1024;
const FINGERPRINT_MAX_ENTRIES = 2_000;

/** The first `count` space-separated fields of a status record, then the rest (its path). */
function splitStatusFields(record: string, count: number): string[] | null {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const end = record.indexOf(" ", start);
    if (end < 0) return null;
    parts.push(record.slice(start, end));
    start = end + 1;
  }
  parts.push(record.slice(start));
  return parts;
}

/**
 * Parses `git status --porcelain=v2 -z --branch` output for a workspace fingerprint, or
 * returns null when the listing cannot describe what a capture would record: an unborn
 * HEAD, a conflict, a submodule entry, a collapsed untracked directory (its own stat does
 * not change when a file deep inside it does), a name that is not valid UTF-8, or more
 * than {@link FINGERPRINT_MAX_ENTRIES} entries. Paths are relative to the repository root.
 */
export function parseFingerprintStatus(stdout: string): {
  readonly head: string;
  readonly records: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
} | null {
  const fields = stdout.split("\0");
  let head: string | null = null;
  const records: string[] = [];
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length === 0) continue;
    if (field.includes("�")) return null;
    if (field.startsWith("# ")) {
      if (field.startsWith("# branch.oid ")) head = field.slice("# branch.oid ".length);
      continue;
    }
    if (field.startsWith("? ")) {
      const entry = field.slice(2);
      if (entry.endsWith("/")) return null;
      records.push(field);
      paths.push(entry);
    } else if (field.startsWith("1 ") || field.startsWith("2 ")) {
      const renamed = field.startsWith("2 ");
      const parts = splitStatusFields(field, renamed ? 9 : 8);
      if (parts === null || !parts[2]!.startsWith("N")) return null;
      paths.push(parts.at(-1)!);
      if (renamed) {
        const original = fields[++index];
        if (original === undefined || original.includes("�")) return null;
        records.push(`${field}\0${original}`);
        paths.push(original);
      } else {
        records.push(field);
      }
    } else {
      return null;
    }
    if (records.length > FINGERPRINT_MAX_ENTRIES) return null;
  }
  if (head === null || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
  return { head, records: records.toSorted(), paths };
}

function isSafeCheckpointRef(ref: string): boolean {
  if (!ref.startsWith("refs/") || /\s/.test(ref)) return false;
  for (const character of ref) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

// On macOS, Git's fsync uses F_FULLFSYNC; writeout-only still uses fsync(2).
// Network mounts can reject F_FULLFSYNC. Ref writes omit errno, so retry their
// bare write error too; explicit unrelated errors remain failures.
// Linux writeout-only only starts writeback, so it must not use this fallback.
const FULL_FSYNC_ARG = "core.fsyncMethod=fsync";
const BATCH_FSYNC_ARG = "core.fsyncMethod=batch";
const WRITEOUT_ONLY_FSYNC_ARG = "core.fsyncMethod=writeout-only";
const isFullFsyncArg = (arg: string) => arg === FULL_FSYNC_ARG || arg === BATCH_FSYNC_ARG;
const canRetryFullFsync = (detail: string) =>
  /fsync error on [^\r\n]+: operation not supported\r?$/im.test(detail) ||
  /cannot update ref [^\r\n]+: couldn't write '[^\r\n]+\.lock'\r?$/im.test(detail);

const makeCheckpointStore = Effect.fn("makeCheckpointStore")(function* (platform: NodeJS.Platform) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitService;
  /** The git-import filter's answer per checkpoint pair, oldest first. */
  const authoredPathsCache = new Map<string, ReadonlyArray<ReadonlyArray<string>> | null>();

  // Set fsync first: Git 2.36 ignores an unknown batch without resetting the method.
  // Git documents batch/fsync equivalence on macOS HFS+/APFS and Windows NTFS/ReFS;
  // keep per-object fsync on other platforms. Batch still fully flushes refs.
  const durableWrite = gitConfigArgs([
    ["core.fsync", "objects,reference"],
    ["core.fsyncMethod", "fsync"],
    ...(platform === "darwin" || platform === "win32"
      ? [["core.fsyncMethod", "batch"] as const]
      : []),
  ]);
  const executeCaptureOnce = (input: ExecuteGitInput) => {
    const env = { ...input.env, LC_ALL: "C", LANGUAGE: "C" };
    return git.execute({ ...input, env }).pipe(
      Effect.catch((error) =>
        platform === "darwin" && input.args.some(isFullFsyncArg) && canRetryFullFsync(error.detail)
          ? git.execute({
              ...input,
              args: input.args.map((arg) => (isFullFsyncArg(arg) ? WRITEOUT_ONLY_FSYNC_ARG : arg)),
              env,
            })
          : Effect.fail(error),
      ),
    );
  };
  // Retry only capture commands with recognizable lock/file disappearance races.
  const executeCapture = (input: ExecuteGitInput) =>
    executeCaptureOnce(input).pipe(
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
      // Scratch index writes must not expire sharedindex files used by the real index.
      const indexConfig = gitConfigArgs([
        ["core.fsmonitor", "false"],
        ["core.splitIndex", "false"],
        ["splitIndex.sharedIndexExpire", "never"],
        ["sparse.expectFilesOutsideOfPatterns", "false"],
      ]);

      return yield* Effect.acquireUseRelease(
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
            // An ignored workspace is a normal outcome, so settle it before any index work.
            // Pass the path as an argument: outside a repository Git exits before reading
            // stdin, and a late stdin write then fails with an unhandled EPIPE.
            const ignoreCheck = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: ["check-ignore", "--no-index", "--", "."],
              allowNonZeroExit: true,
            });
            if (ignoreCheck.code !== 0 && ignoreCheck.code !== 1) {
              return yield* new GitCommandError({
                operation,
                command: "git check-ignore",
                cwd: input.cwd,
                detail: ignoreCheck.stderr.trim() || "git check-ignore failed.",
              });
            }
            const workspaceIgnored = ignoreCheck.code === 0 && ignoreCheck.stdout.trim() === ".";
            // HEAD omits staged-only paths. Seed just this workspace's additions so
            // unrelated staged changes elsewhere in the repository stay out.
            const ignoredAdditions = workspaceIgnored
              ? (yield* executeCapture({
                  operation,
                  cwd: input.cwd,
                  args: [
                    ...gitConfigArgs([["core.quotePath", "true"]]),
                    "diff",
                    "--cached",
                    "--raw",
                    "--no-abbrev",
                    "--no-renames",
                    "--no-relative",
                    "--ignore-submodules=none",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--ita-visible-in-index",
                    "--diff-filter=A",
                    "--",
                    ".",
                  ],
                  maxOutputBytes: AUTHORED_PATHS_MAX_OUTPUT_BYTES,
                })).stdout
              : "";
            if (workspaceIgnored && ignoredAdditions.length === 0) {
              // The scratch index is HEAD plus these additions, so HEAD holding a tree
              // here is the only other way the workspace can have tracked files.
              const headTree =
                capturedHead === null
                  ? null
                  : yield* executeCapture({
                      operation,
                      cwd: input.cwd,
                      args: ["rev-parse", "--verify", "--quiet", `${capturedHead}:./`],
                      allowNonZeroExit: true,
                    });
              if (headTree === null || headTree.code !== 0) {
                return yield* new CheckpointUnsupportedError({
                  operation,
                  cwd: input.cwd,
                  detail: "The workspace directory is ignored by its Git repository.",
                });
              }
            }
            const sparseResult = yield* executeCapture({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "--", "core.sparseCheckout"],
              allowNonZeroExit: true,
            });
            const sparse = sparseResult.stdout.trim() === "true";
            // `git status` never inspects assume-unchanged or skip-worktree entries, so a
            // fingerprint can stand in for this capture only once the index is known to
            // have none.
            let indexFlagsClean = false;
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
                indexFlagsClean = !specialFlags;
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

            if (ignoredAdditions.length > 0) {
              // Quoted paths round-trip through index-info, including non-UTF-8 names.
              yield* executeCapture({
                operation,
                cwd: input.cwd,
                args: [
                  ...indexConfig,
                  ...gitConfigArgs([["index.sparse", "false"]]),
                  "update-index",
                  "--index-info",
                ],
                stdin: ignoredAdditions.replace(
                  /^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A\t/gm,
                  "$1 $2\t",
                ),
                env: commitEnv,
              });
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
                  // add -A rejects an ignored directory even when it holds tracked files.
                  workspaceIgnored ? "-u" : "-A",
                  "--",
                  ".",
                  ...exclusions,
                ],
                env: commitEnv,
                // Durable object writes on NTFS can exceed the normal command
                // deadline for large checkpoints. Keep staging bounded without
                // weakening fsync or changing deadlines for other Git commands.
                timeoutMs: platform === "win32" ? 120_000 : 30_000,
              });
            const excluded = (input.excludePaths ?? []).map(
              (entry) => ":(exclude,literal)" + entry,
            );
            yield* stageFiles(excluded).pipe(
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
                  return [...excluded, ...exclusions];
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
            return {
              commitOid,
              reusable: !sparse && !workspaceIgnored && indexFlagsClean,
            } as const;
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

  const fingerprintWorkspace: CheckpointStoreShape["fingerprintWorkspace"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.fingerprintWorkspace";
      const excludePaths = [...(input.excludePaths ?? [])].toSorted();
      const pathspecs = ["--", ".", ...excludePaths.map((entry) => ":(exclude,literal)" + entry)];
      // Never takes the index lock: this runs beside the user's own Git.
      const env = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANGUAGE: "C" };
      const [locations, fsmonitor] = yield* Effect.all(
        [
          git.execute({
            operation,
            cwd: input.cwd,
            args: ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-path", "index"],
            env,
          }),
          // A non-boolean value names a hook script, which F5 must not run on its own.
          git.execute({
            operation,
            cwd: input.cwd,
            args: ["config", "--type=bool", "--get", "core.fsmonitor"],
            env,
            allowNonZeroExit: true,
          }),
        ],
        { concurrency: 2 },
      );
      const [root = "", indexPath = ""] = locations.stdout.split(/\r?\n/);
      if (root.length === 0 || indexPath.length === 0) return null;
      // Unlike a capture's scratch index, the listing trusts the repository's own built-in
      // fsmonitor daemon and untracked cache, as the user's `git status` does. A daemon
      // that misses an event hides that edit from reuse until a later change is seen.
      const status = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          ...(fsmonitor.code > 1 ? gitConfigArgs([["core.fsmonitor", "false"]]) : []),
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=normal",
          // A capture records a submodule's commit, never its worktree.
          "--ignore-submodules=dirty",
          ...pathspecs,
        ],
        env,
        maxOutputBytes: FINGERPRINT_MAX_OUTPUT_BYTES,
      });
      const parsed = parseFingerprintStatus(status.stdout);
      if (parsed === null) return null;
      if (input.commitOid !== undefined) {
        // The commit must change exactly the paths the listing shows as changed, so an
        // edit made and undone while it was captured cannot pass for this state.
        const committed = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--ignore-submodules=dirty",
            parsed.head,
            input.commitOid,
            ...pathspecs,
          ],
          env,
          maxOutputBytes: FINGERPRINT_MAX_OUTPUT_BYTES,
        });
        const changed = new Set(committed.stdout.split("\0").filter((entry) => entry.length > 0));
        const listed = new Set(parsed.paths);
        if (changed.size !== listed.size || [...listed].some((entry) => !changed.has(entry)))
          return null;
      }
      const signature = (target: string, label: string) =>
        lstat(target, { bigint: true }).then(
          (stat) =>
            `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.mode}:${label}`,
          () => `absent:${label}`,
        );
      const [indexSignature, ...signatures] = yield* Effect.tryPromise(() =>
        Promise.all([
          // Setting assume-unchanged or skip-worktree rewrites the index, which `git
          // status` would otherwise not notice.
          signature(indexPath, "index"),
          ...parsed.paths.map((entry) => signature(path.join(root, entry), entry)),
        ]),
      );
      return createHash("sha256")
        .update(
          JSON.stringify([
            parsed.head,
            parsed.records,
            indexSignature,
            signatures.toSorted(),
            excludePaths,
          ]),
        )
        .digest("hex");
    }).pipe(Effect.orElseSucceed(() => null));

  const reuseCheckpoint: CheckpointStoreShape["reuseCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reuseCheckpoint";
      if (
        !isSafeCheckpointRef(input.sourceRef) ||
        !isSafeCheckpointRef(input.targetRef) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.sourceOid)
      )
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Invalid checkpoint ref or object id for reuse.",
        });
      const result = yield* executeCapture({
        operation,
        cwd: input.cwd,
        args: [...durableWrite, "update-ref", "--stdin"],
        stdin:
          "start\n" +
          `verify ${input.sourceRef} ${input.sourceOid}\n` +
          `update ${input.targetRef} ${input.sourceOid}\n` +
          "prepare\ncommit\n",
        allowNonZeroExit: true,
      });
      return result.code === 0;
    });

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

      const pathspecs = [
        ".",
        ...(input.excludePaths ?? []).map((entry) => ":(exclude,literal)" + entry),
      ];
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
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", ...pathspecs],
      });
      yield* recreateWorkspace;
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", ...pathspecs],
      });
      yield* recreateWorkspace;

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", ...pathspecs],
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
      const prefix = input.options?.repositoryPath ? input.options.repositoryPath + "/" : "";
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
              "--src-prefix=a/" + prefix,
              "--dst-prefix=b/" + prefix,
              ...(input.options?.minimal === false ? [] : ["--minimal"]),
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
    fingerprintWorkspace,
    reuseCheckpoint,
    hasCheckpointRef,
    readCheckpointRefs,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const makeCheckpointStoreLayer = (platform: NodeJS.Platform = process.platform) =>
  Layer.effect(CheckpointStore, makeCheckpointStore(platform));

export const CheckpointStoreLiveWithGitService = makeCheckpointStoreLayer();

/** Credential-free test harness; production runtimes must supply their configured Git service. */
export const CheckpointStoreLiveWithoutCredentials = CheckpointStoreLiveWithGitService.pipe(
  Layer.provideMerge(GitServiceLive),
);
