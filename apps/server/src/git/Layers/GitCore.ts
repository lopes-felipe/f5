import { gitConfigArgs, literalGitPathspec } from "@t3tools/shared/git";
import { makeMoveSnapshotOperations } from "../moveSnapshot.ts";
import { checkoutFingerprint } from "../checkoutFingerprint.ts";
import { blockingIgnoredEntries } from "../worktreeIgnoredFiles.ts";
import { createHash, randomUUID } from "node:crypto";
import { parseCleanupSafetyStatus } from "../cleanupSafety.ts";
import { basename, dirname } from "node:path";
import {
  WorktreePreparations,
  type WorktreePreparationReceipt,
} from "../../persistence/Services/WorktreePreparations.ts";
import { lstat as inspectPath, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { parseWorktreeListPorcelain, stripPathTerminator } from "../worktreeList.ts";
import { isRefLockFailure, networkFailureDetail } from "../networkFailureDetail.ts";
import {
  withWorktreeLifecycleLock,
  withoutLifecycleLocks,
  withRepositoryLifecycleLock,
  repositoryIdentityHash,
  pathContains,
} from "../../project/Layers/WorktreeLifecycleCoordinator.ts";
import {
  parseRemoteFetchUrls,
  NONINTERACTIVE_GIT_ENV as BACKGROUND_GIT_FETCH_ENV,
} from "../remoteInspection.ts";
import {
  isAbsolute as isAbsolutePath,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";

import {
  Cache,
  Data,
  Deferred,
  Fiber,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect";

import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import { GitCommandError } from "../Errors.ts";
import { checkoutConflictFiles } from "../checkoutConflict.ts";
import { GitService } from "../Services/GitService.ts";
import {
  GitCore,
  type GitCoreShape,
  type GitWorktreeProgress,
  type GitPreparedCommitContext,
} from "../Services/GitCore.ts";
import { copiedIndexTimestampSeconds } from "../copiedIndex.ts";
import { makeProgressLineSplitter, parseCheckoutProgressLine } from "../progressLines.ts";
import {
  isPullRequestTrackingAlias,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../remoteRefs.ts";
import { ServerConfig } from "../../config.ts";
import {
  canonicalWorktreePath,
  worktreePathSlug,
  worktreePathExceedsWindowsLimit,
} from "../worktreePaths.ts";

const inspectionSemaphore = Semaphore.makeUnsafe(4);
const fullInspectionSemaphore = Semaphore.makeUnsafe(4);

const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_RETRY_INTERVAL = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_UPSTREAM_REFRESH_GENERATION_CAPACITY = STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY;
const STATUS_STATIC_METADATA_CACHE_TTL = Duration.seconds(15);
const STATUS_STATIC_METADATA_FAILURE_CACHE_TTL = Duration.seconds(5);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  commonDir: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

class StatusStaticMetadataCacheKey extends Data.Class<{
  cwd: string;
  repositoryFingerprint: string;
}> {}

interface StatusStaticMetadata {
  readonly commonDir: string;
  readonly remoteNames: ReadonlyArray<string>;
  readonly primaryRemoteName: string | null;
  readonly defaultBranchName: string | null;
}

interface ExecuteGitOptions {
  timeoutMs?: number | null | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onStderrChunk?: ((chunk: Uint8Array) => void) | undefined;
  onStdoutChunk?: ((chunk: Uint8Array) => void) | undefined;
}

// Streams output past the cap while keeping a bounded tail for failure details.
const discardOutputChunk = () => {};

function sameStringSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const expected = new Set(right);
  return new Set(left).size === expected.size && left.every((value) => expected.has(value));
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    let rawPath = record.slice(secondTab + 1);
    if (rawPath.length === 0) {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (oldPath === undefined || newPath === undefined) continue;
      rawPath = newPath;
      index += 2;
    }
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    entries.push({
      path: rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function fieldAfterSpaces(record: string, count: number): string | null {
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    offset = record.indexOf(" ", offset);
    if (offset === -1) return null;
    offset += 1;
  }
  const value = record.slice(offset);
  return value.length > 0 ? value : null;
}

function parsePorcelainPath(record: string): string | null {
  if (record.startsWith("? ") || record.startsWith("! ")) {
    const simple = record.slice(2);
    return simple.length > 0 ? simple : null;
  }
  if (record.startsWith("1 ")) return fieldAfterSpaces(record, 8);
  if (record.startsWith("2 ")) return fieldAfterSpaces(record, 9);
  if (record.startsWith("u ")) return fieldAfterSpaces(record, 10);
  return null;
}

function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isUnsafeRefArgument(name: string): boolean {
  return !name || name.startsWith("-") || name.includes("\0");
}

function missingCwdErrorDetail(cwd: string): string {
  return `Working directory does not exist: ${cwd}`;
}

const makeGitCore = Effect.gen(function* () {
  const serviceScope = yield* Effect.scope;
  const upstreamRefreshJobs = new Map<string, Set<Fiber.Fiber<void>>>();
  const launchUpstreamRefresh = (cwd: string, work: Effect.Effect<void, GitCommandError>) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let job: Fiber.Fiber<void>;
      job = yield* Deferred.await(ready).pipe(
        Effect.andThen(work),
        Effect.ignoreCause({ log: true }),
        withoutLifecycleLocks,
        Effect.ensuring(
          Effect.sync(() => {
            const jobs = upstreamRefreshJobs.get(cwd);
            jobs?.delete(job);
            if (jobs?.size === 0) upstreamRefreshJobs.delete(cwd);
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      const jobs = upstreamRefreshJobs.get(cwd) ?? new Set<Fiber.Fiber<void>>();
      jobs.add(job);
      upstreamRefreshJobs.set(cwd, jobs);
      yield* Deferred.succeed(ready, undefined);
    });

  const statusRefreshListeners = new Set<(cwd: string) => void>();
  yield* Effect.addFinalizer(() => Effect.sync(() => statusRefreshListeners.clear()));
  const git = yield* GitService;
  const preparations = yield* WorktreePreparations;
  const { worktreesDir, baseDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  // Fail-fast guard: if the working directory no longer exists on disk, short-circuit
  // with a clear error instead of paying a child-process spawn + ENOENT per call.
  // This is important for polled endpoints (`git.status`, `git.listBranches`) that
  // target stale worktree paths left over from externally-deleted directories.
  const ensureCwdExists = (operation: string, cwd: string): Effect.Effect<void, GitCommandError> =>
    fileSystem.exists(cwd).pipe(
      Effect.catch(() => Effect.succeed(false)),
      Effect.flatMap((exists) =>
        exists
          ? Effect.void
          : Effect.fail(createGitCommandError(operation, cwd, [], missingCwdErrorDetail(cwd))),
      ),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
    git
      .execute({
        operation,
        cwd,
        args,
        ...(options.env ? { env: options.env } : {}),
        ...(options.onStderrChunk ? { onStderrChunk: options.onStderrChunk } : {}),
        ...(options.onStdoutChunk ? { onStdoutChunk: options.onStdoutChunk } : {}),
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })
      .pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          if (["fetch", "push", "pull", "ls-remote"].includes(args[0] ?? "")) {
            return Effect.fail(
              createGitCommandError(
                operation,
                cwd,
                args.map((argument) =>
                  argument.includes("://") || argument.includes("@") ? "<remote>" : argument,
                ),
                `${options.fallbackErrorMessage ?? `Git ${args[0]} failed`}: ${networkFailureDetail(result.stderr)} (exit ${result.code})`,
              ),
            );
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
        withMetrics({
          counter: gitCommandsTotal,
          timer: gitCommandDuration,
          attributes: {
            operation,
          },
        }),
        Effect.withSpan(operation, {
          kind: "client",
          attributes: {
            "git.operation": operation,
            "git.cwd": cwd,
            "git.args_count": args.length,
          },
        }),
      );

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.code === 0 || result.code === 1
          ? Effect.succeed(result.code === 0)
          : Effect.fail(createGitCommandError("GitCore.branchExists", cwd, [], result.stderr)),
      ),
    );

  const resolveAvailableBranchName = (
    cwd: string,
    desiredBranch: string,
  ): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const identity = yield* canonicalPath(yield* resolveCommonDir(cwd));
      const reserved = (name: string) =>
        preparations
          .branchReserved(identity, name)
          .pipe(
            Effect.mapError((error) =>
              createGitCommandError("GitCore.resolveAvailableBranchName", cwd, [], error.message),
            ),
          );
      const isDesiredTaken =
        (yield* branchExists(cwd, desiredBranch)) || (yield* reserved(desiredBranch));
      if (!isDesiredTaken) {
        return desiredBranch;
      }

      for (let suffix = 1; suffix <= 100; suffix += 1) {
        const candidate = `${desiredBranch}-${suffix}`;
        const isCandidateTaken =
          (yield* branchExists(cwd, candidate)) || (yield* reserved(candidate));
        if (!isCandidateTaken) {
          return candidate;
        }
      }

      return yield* createGitCommandError(
        "GitCore.renameBranch",
        cwd,
        ["branch", "-m", "--", desiredBranch],
        `Could not find an available branch name for '${desiredBranch}'.`,
      );
    });

  const statusStaticMetadataCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: ({
      cwd,
    }: StatusStaticMetadataCacheKey): Effect.Effect<StatusStaticMetadata, GitCommandError> =>
      Effect.gen(function* () {
        const [commonDirStdout, remoteNamesStdout] = yield* Effect.all(
          [
            runGitStdout("GitCore.statusStaticMetadata.commonDir", cwd, [
              "rev-parse",
              "--git-common-dir",
            ]),
            runGitStdout("GitCore.statusStaticMetadata.remoteNames", cwd, ["remote"]),
          ],
          { concurrency: "unbounded" },
        );
        const commonDirValue = stripPathTerminator(commonDirStdout);
        const commonDir =
          commonDirValue.length === 0
            ? cwd
            : isAbsolutePath(commonDirValue)
              ? commonDirValue
              : resolvePath(cwd, commonDirValue);
        const remoteNames = parseRemoteNamesInGitOrder(remoteNamesStdout);
        const primaryRemoteName = remoteNames.includes("origin")
          ? "origin"
          : (remoteNames[0] ?? null);
        const defaultBranchName = primaryRemoteName
          ? yield* executeGit(
              "GitCore.statusStaticMetadata.defaultBranch",
              cwd,
              ["symbolic-ref", `refs/remotes/${primaryRemoteName}/HEAD`],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.map((result) =>
                result.code === 0
                  ? parseDefaultBranchFromRemoteHeadRef(result.stdout, primaryRemoteName)
                  : null,
              ),
            )
          : null;
        return { commonDir, remoteNames, primaryRemoteName, defaultBranchName };
      }),
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_STATIC_METADATA_CACHE_TTL
        : STATUS_STATIC_METADATA_FAILURE_CACHE_TTL,
  });

  const statFingerprint = (path: string): Effect.Effect<string> =>
    fileSystem.stat(path).pipe(
      Effect.map(
        (info) =>
          `${String(info.dev)}:${info.ino === undefined ? "" : String(info.ino)}:${String(info.size)}:${info.mtime?.getTime() ?? ""}`,
      ),
      Effect.catch(() => Effect.succeed("missing")),
    );

  const readOptionalFile = (path: string): Effect.Effect<string | null> =>
    fileSystem.readFileString(path).pipe(
      Effect.map((contents) => contents),
      Effect.catch(() => Effect.succeed(null)),
    );

  const repositoryMetadataFingerprint = (cwd: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const dotGitPath = resolvePath(cwd, ".git");
      const dotGitContents = yield* readOptionalFile(dotGitPath);
      const gitDirValue = dotGitContents?.startsWith("gitdir: ")
        ? stripPathTerminator(dotGitContents).slice(8)
        : undefined;
      const gitDir = gitDirValue
        ? isAbsolutePath(gitDirValue)
          ? gitDirValue
          : resolvePath(cwd, gitDirValue)
        : dotGitPath;
      const commonDirValue = (yield* readOptionalFile(resolvePath(gitDir, "commondir")))?.replace(
        /\n$/,
        "",
      );
      const commonDir = commonDirValue
        ? isAbsolutePath(commonDirValue)
          ? commonDirValue
          : resolvePath(gitDir, commonDirValue)
        : gitDir;
      const [dotGitFingerprint, gitDirFingerprint, configFingerprint] = yield* Effect.all(
        [
          statFingerprint(dotGitPath),
          statFingerprint(gitDir),
          statFingerprint(resolvePath(commonDir, "config")),
        ],
        { concurrency: "unbounded" },
      );
      return `${dotGitFingerprint}|${gitDirFingerprint}|${configFingerprint}`;
    });

  const readStatusStaticMetadata = (
    cwd: string,
  ): Effect.Effect<StatusStaticMetadata, GitCommandError> =>
    repositoryMetadataFingerprint(cwd).pipe(
      Effect.flatMap((repositoryFingerprint) =>
        Cache.get(
          statusStaticMetadataCache,
          new StatusStaticMetadataCacheKey({ cwd, repositoryFingerprint }),
        ),
      ),
    );

  const resolveCurrentUpstream = (
    cwd: string,
  ): Effect.Effect<
    { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
    GitCommandError
  > =>
    Effect.gen(function* () {
      const upstreamRef = yield* runGitStdout(
        "GitCore.resolveCurrentUpstream",
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
        return null;
      }

      const { remoteNames } = yield* readStatusStaticMetadata(cwd);
      const parsedRemoteRef = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
      if (!parsedRemoteRef) {
        return null;
      }

      const { remoteName, branchName: upstreamBranch } = parsedRemoteRef;
      if (remoteName.length === 0 || upstreamBranch.length === 0) {
        return null;
      }

      return {
        upstreamRef,
        remoteName,
        upstreamBranch,
      };
    });

  const sweptStatusRepositories = new Set<string>();
  let legacyStatusFetch = false;
  const sweepStatusRefs = (cwd: string) =>
    Effect.gen(function* () {
      const commonDir = yield* canonicalPath(yield* resolveCommonDir(cwd));
      if (sweptStatusRepositories.has(commonDir)) return;
      sweptStatusRepositories.add(commonDir);
      if (sweptStatusRepositories.size > 256)
        sweptStatusRepositories.delete(sweptStatusRepositories.values().next().value!);
      const refs = yield* runGitStdout("GitCore.sweepStatusRefs", cwd, [
        "for-each-ref",
        "--count=256",
        "--format=%(refname)%09%(objectname)",
        "refs/f5/status/",
      ]);
      const cutoff = Date.now() - 30 * 60_000;
      for (const line of refs.trim().split("\n")) {
        const [ref, oid] = line.split("\t");
        if (!ref || !oid || !/^refs\/f5\/status\/(?:\d{13,}-)?[a-f0-9-]+$/.test(ref)) continue;
        const timestamp = /^refs\/f5\/status\/(\d{13,})-/.exec(ref)?.[1];
        // Earlier builds used bare UUIDs. Only filesystem age establishes their
        // age; a commit's timestamp says nothing about when its ref was created.
        const created = timestamp
          ? Number(timestamp)
          : yield* Effect.promise(async () => {
              try {
                return (await inspectPath(joinPath(commonDir, ref))).mtimeMs;
              } catch {
                try {
                  return (await inspectPath(joinPath(commonDir, "packed-refs"))).mtimeMs;
                } catch {
                  return Infinity;
                }
              }
            });
        if (created >= cutoff) continue;
        yield* withRepositoryLock(
          "GitCore.sweepStatusRefs",
          cwd,
          executeGit("GitCore.sweepStatusRefs", cwd, ["update-ref", "-d", ref, oid], {
            allowNonZeroExit: true,
          }),
          "background",
        );
      }
    });

  const fetchUpstreamRefInBackground = (
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
    env: NodeJS.ProcessEnv,
  ): Effect.Effect<boolean, GitCommandError> =>
    Effect.gen(function* () {
      const operation = "GitCore.fetchUpstreamRefInBackground";
      yield* sweepStatusRefs(cwd).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("status refresh ref sweep failed", { cause: String(cause) }),
        ),
      );
      const destination = `refs/remotes/${upstream.upstreamRef}`;
      const before = yield* executeGit(operation, cwd, ["rev-parse", "--verify", destination], {
        allowNonZeroExit: true,
      });
      const previous = before.code === 0 ? before.stdout.trim() : "";
      const temporary = `refs/f5/status/${Date.now()}-${randomUUID()}`;
      // Download under an isolated ref: concurrent user pulls must own FETCH_HEAD
      // and their tracking refs. Only the short compare-and-set takes the shared lock.
      return yield* Effect.acquireUseRelease(
        Effect.succeed(temporary),
        (ref) =>
          Effect.gen(function* () {
            const fetch = (legacy: boolean) =>
              executeGit(
                operation,
                cwd,
                [
                  "fetch",
                  "--quiet",
                  "--no-tags",
                  ...(legacy ? [] : ["--no-write-fetch-head", "--no-auto-maintenance"]),
                  "--refmap=",
                  "--",
                  upstream.remoteName,
                  `+refs/heads/${upstream.upstreamBranch}:${ref}`,
                ],
                {
                  timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
                  env,
                  allowNonZeroExit: true,
                },
              );
            // Older Git cannot isolate FETCH_HEAD. Serialize its compatibility
            // path with user fetch/pull operations, retaining the temporary ref/CAS.
            const compatibleFetch = () =>
              withRepositoryLock(operation, cwd, fetch(true), "background");
            let fetched = yield* legacyStatusFetch ? compatibleFetch() : fetch(false);
            if (
              fetched.code !== 0 &&
              /(?:unknown|unrecognized) option/i.test(fetched.stderr) &&
              !legacyStatusFetch
            ) {
              legacyStatusFetch = true;
              yield* Effect.logWarning(
                "Background Git refresh is using compatibility mode; fetch is serialized with repository writes.",
              );
              fetched = yield* compatibleFetch();
            }
            if (fetched.code !== 0) return false;
            const head = yield* runGitStdout(operation, cwd, ["rev-parse", "--verify", ref]);
            if (head.trim() === previous) return true;
            return yield* withRepositoryLock(
              operation,
              cwd,
              executeGit(operation, cwd, ["update-ref", destination, head.trim(), previous], {
                allowNonZeroExit: true,
              }),
              "background",
            ).pipe(Effect.map((result) => result.code === 0));
          }),
        (ref) =>
          executeGit(operation, cwd, ["update-ref", "-d", ref], { allowNonZeroExit: true }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to clean up status refresh ref", { cause: String(cause) }),
            ),
            Effect.asVoid,
          ),
      );
    });

  const statusUpstreamRefreshGenerationRef = yield* Ref.make(new Map<string, number>());
  const statusUpstreamRefreshGenerationKey = (key: StatusUpstreamRefreshCacheKey) =>
    `${key.cwd}\0${key.commonDir}`;
  const startStatusRefreshGeneration = (key: StatusUpstreamRefreshCacheKey) =>
    Ref.modify(statusUpstreamRefreshGenerationRef, (current) => {
      const generationKey = statusUpstreamRefreshGenerationKey(key);
      const nextGeneration = (current.get(generationKey) ?? 0) + 1;
      const next = new Map(current);
      next.delete(generationKey);
      next.set(generationKey, nextGeneration);
      while (next.size > STATUS_UPSTREAM_REFRESH_GENERATION_CAPACITY) {
        const oldestKey = next.keys().next().value;
        if (!oldestKey) break;
        next.delete(oldestKey);
      }
      return [nextGeneration, next] as const;
    });
  const isLatestStatusRefreshGeneration = (
    key: StatusUpstreamRefreshCacheKey,
    generation: number,
  ) =>
    Ref.get(statusUpstreamRefreshGenerationRef).pipe(
      Effect.map((current) => current.get(statusUpstreamRefreshGenerationKey(key)) === generation),
    );

  const statusUpstreamRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
      Effect.gen(function* () {
        const generation = yield* startStatusRefreshGeneration(cacheKey);
        const fetched = yield* fetchUpstreamRefInBackground(
          cacheKey.cwd,
          {
            upstreamRef: cacheKey.upstreamRef,
            remoteName: cacheKey.remoteName,
            upstreamBranch: cacheKey.upstreamBranch,
          },
          {
            ...process.env,
            ...BACKGROUND_GIT_FETCH_ENV,
          },
        );
        const latest = yield* isLatestStatusRefreshGeneration(cacheKey, generation);
        if (latest && fetched)
          yield* Effect.sync(() => {
            for (const listener of statusRefreshListeners) listener(cacheKey.cwd);
          });
        return latest && fetched;
      }),
    // Keep successful refreshes warm and briefly cool down refresh failures so repeated
    // status checks in the same action do not pay the full upstream timeout each time.
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_RETRY_INTERVAL,
  });

  const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      const { commonDir } = yield* readStatusStaticMetadata(cwd);
      yield* Cache.get(
        statusUpstreamRefreshCache,
        new StatusUpstreamRefreshCacheKey({
          cwd,
          commonDir,
          upstreamRef: upstream.upstreamRef,
          remoteName: upstream.remoteName,
          upstreamBranch: upstream.upstreamBranch,
        }),
      );
    });

  const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
    Effect.gen(function* () {
      const upstream = yield* resolveCurrentUpstream(cwd);
      if (!upstream) return;
      yield* fetchUpstreamRefInBackground(cwd, upstream, {
        ...process.env,
        ...BACKGROUND_GIT_FETCH_ENV,
      });
    });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    readStatusStaticMetadata(cwd).pipe(
      Effect.flatMap((metadata) =>
        metadata.primaryRemoteName === remoteName
          ? Effect.succeed(metadata.defaultBranchName)
          : executeGit(
              "GitCore.resolveDefaultBranchName",
              cwd,
              ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
              { allowNonZeroExit: true },
            ).pipe(
              Effect.map((result) =>
                result.code === 0
                  ? parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName)
                  : null,
              ),
            ),
      ),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    branch: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    readStatusStaticMetadata(cwd).pipe(Effect.map((metadata) => metadata.remoteNames));

  const hasRemote: GitCoreShape["hasRemote"] = (cwd) =>
    listRemoteNames(cwd).pipe(Effect.map((remotes) => remotes.length > 0));

  const resolvePrimaryRemoteName = (cwd: string): Effect.Effect<string, GitCommandError> =>
    Effect.gen(function* () {
      const { primaryRemoteName } = yield* readStatusStaticMetadata(cwd);
      if (primaryRemoteName) {
        return primaryRemoteName;
      }
      return yield* createGitCommandError(
        "GitCore.resolvePrimaryRemoteName",
        cwd,
        ["remote"],
        "No git remote is configured for this repository.",
      );
    });

  const resolvePushRemoteName = (
    cwd: string,
    branch: string,
    upstreamRemote?: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const branchPushRemote = yield* runGitStdout(
        "GitCore.resolvePushRemoteName.branchPushRemote",
        cwd,
        ["config", "--get", "--", `branch.${branch}.pushRemote`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      if (branchPushRemote.length > 0) {
        return branchPushRemote;
      }

      const pushDefaultRemote = yield* runGitStdout(
        "GitCore.resolvePushRemoteName.remotePushDefault",
        cwd,
        ["config", "--get", "--", "remote.pushDefault"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      if (pushDefaultRemote.length > 0) {
        return pushDefaultRemote;
      }

      return (
        upstreamRemote ??
        (yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null))))
      );
    });

  const ensureRemote: GitCoreShape["ensureRemote"] = (input) =>
    Effect.gen(function* () {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeRemoteUrl(input.url);
      const remoteFetchUrls = yield* runGitStdout(
        "GitCore.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

      for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
        if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
          return remoteName;
        }
      }

      let remoteName = preferredName;
      let suffix = 1;
      while (remoteFetchUrls.has(remoteName)) {
        remoteName = `${preferredName}-${suffix}`;
        suffix += 1;
      }

      yield* runGit("GitCore.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        "--",
        remoteName,
        input.url,
      ]);
      return remoteName;
    });

  const resolveBaseBranchForNoUpstream = (
    cwd: string,
    branch: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    Effect.gen(function* () {
      const configuredBaseBranch = yield* runGitStdout(
        "GitCore.resolveBaseBranchForNoUpstream.config",
        cwd,
        ["config", "--get", "--", `branch.${branch}.gh-merge-base`],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const defaultBranch =
        primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
      const candidates = [
        configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
        defaultBranch,
        ...DEFAULT_BASE_BRANCH_CANDIDATES,
      ];

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        const remotePrefix =
          primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
        const normalizedCandidate = candidate.startsWith("origin/")
          ? candidate.slice("origin/".length)
          : remotePrefix && candidate.startsWith(remotePrefix)
            ? candidate.slice(remotePrefix.length)
            : candidate;
        if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
          continue;
        }

        if (yield* branchExists(cwd, normalizedCandidate)) {
          return normalizedCandidate;
        }

        if (
          primaryRemoteName &&
          (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
        ) {
          return `${primaryRemoteName}/${normalizedCandidate}`;
        }
      }

      return null;
    });

  const computeAheadCountAgainstBase = (
    cwd: string,
    branch: string,
  ): Effect.Effect<number, GitCommandError> =>
    Effect.gen(function* () {
      const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
      if (!baseBranch) {
        return 0;
      }

      const result = yield* executeGit(
        "GitCore.computeAheadCountAgainstBase",
        cwd,
        // Ahead count intentionally uses two-dot semantics: count commits reachable from HEAD
        // that are not reachable from the base. Three-dot would include commits unique to both
        // sides and would no longer mean "ahead".
        ["rev-list", "--count", "--end-of-options", `${baseBranch}..HEAD`, "--"],
        { allowNonZeroExit: true },
      );
      if (result.code !== 0) {
        return 0;
      }

      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    });

  const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
    Effect.gen(function* () {
      const branchRecency = yield* executeGit(
        "GitCore.readBranchRecency",
        cwd,
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
        {
          timeoutMs: 15_000,
          allowNonZeroExit: true,
        },
      );

      const branchLastCommit = new Map<string, number>();
      if (branchRecency.code !== 0) {
        return branchLastCommit;
      }

      for (const line of branchRecency.stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [name, lastCommitRaw] = line.split("\t");
        if (!name) {
          continue;
        }
        const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      }

      return branchLastCommit;
    });

  const statusDetails: GitCoreShape["statusDetails"] = (cwd, options) =>
    Effect.gen(function* () {
      // Short-circuit if the worktree directory has been deleted on disk. Without
      // this, `git.status` polling spams ENOENT errors every few seconds for stale
      // worktree paths still referenced by the projection DB.
      yield* ensureCwdExists("GitCore.statusDetails", cwd);

      const index = yield* executeGit(
        "GitCore.statusDetails.indexPath",
        cwd,
        ["rev-parse", "--git-path", "index"],
        { allowNonZeroExit: true },
      );
      if (index.code === 0 && index.stdout.trim()) {
        const locked = yield* fileSystem
          .exists(`${resolvePath(cwd, stripPathTerminator(index.stdout))}.lock`)
          .pipe(
            Effect.mapError((cause) =>
              createGitCommandError(
                "GitCore.statusDetails.indexPath",
                cwd,
                [],
                "Failed to check the Git index lock.",
                cause,
              ),
            ),
          );
        if (locked) {
          return yield* createGitCommandError(
            "GitCore.statusDetails.indexPath",
            cwd,
            [],
            "Git index is locked. Status will resume when the index lock is removed.",
          );
        }
      }

      if (options?.refreshUpstream !== false)
        yield* launchUpstreamRefresh(cwd, refreshStatusUpstreamIfStale(cwd));

      // Porcelain diff can refresh the real index even with optional locks
      // disabled. Plumbing preserves status totals without that side effect.
      const [statusStdout, unstagedNumstatStdout, stagedNumstatStdout, headNumstatResult] =
        yield* Effect.all(
          [
            executeGit(
              "GitCore.statusDetails.status",
              cwd,
              ["status", "--porcelain=2", "--branch", "-z"],
              { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
            ).pipe(Effect.map((result) => result.stdout)),
            runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, [
              "diff-files",
              "-M",
              "--numstat",
              "-z",
            ]),
            runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
              "diff",
              "--cached",
              "--numstat",
              "-z",
            ]),
            executeGit(
              "GitCore.statusDetails.headNumstat",
              cwd,
              ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"],
              { allowNonZeroExit: true },
            ),
          ],
          { concurrency: "unbounded" },
        );

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      let hasUnbornHead = false;
      const changedFilesWithoutNumstat = new Set<string>();

      const statusRecords = statusStdout.split("\0");
      for (let index = 0; index < statusRecords.length; index += 1) {
        const line = statusRecords[index]!;
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line === "# branch.oid (initial)") {
          hasUnbornHead = true;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.trim().length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainPath(line);
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
          if (line.startsWith("2 ")) index += 1;
        }
      }

      if (!upstreamRef && branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
        behindCount = 0;
      }

      const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
      const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of [...stagedEntries, ...unstagedEntries]) {
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.insertions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      const files = Array.from(fileStatMap.entries())
        .map(([filePath, stat]) => ({
          path: filePath,
          insertions: stat.insertions,
          deletions: stat.deletions,
        }))
        .toSorted((a, b) => a.path.localeCompare(b.path));

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      const aggregateEntries =
        headNumstatResult.code === 0 ? parseNumstatEntries(headNumstatResult.stdout) : [];
      const aggregate = aggregateEntries.reduce(
        (total, entry) => ({
          insertions: total.insertions + entry.insertions,
          deletions: total.deletions + entry.deletions,
        }),
        { insertions: 0, deletions: 0 },
      );
      const splitAggregate = files.reduce(
        (total, file) => ({
          insertions: total.insertions + file.insertions,
          deletions: total.deletions + file.deletions,
        }),
        { insertions: 0, deletions: 0 },
      );
      const insertions = hasUnbornHead
        ? 0
        : headNumstatResult.code === 0
          ? aggregate.insertions
          : splitAggregate.insertions;
      const deletions = hasUnbornHead
        ? 0
        : headNumstatResult.code === 0
          ? aggregate.deletions
          : splitAggregate.deletions;

      const result = {
        branch,
        upstreamRef,
        hasWorkingTreeChanges,
        workingTree: {
          files,
          insertions,
          deletions,
          ...(hasUnbornHead ? { countUnavailableReason: "unborn_head" as const } : {}),
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      };
      return result;
    });

  const checkoutExists = (path: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await inspectPath(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      catch: (cause) =>
        createGitCommandError(
          "GitCore.inspectPath",
          path,
          [],
          "Cannot inspect checkout directory.",
          cause,
        ),
    });

  const canonicalPath = (value: string) =>
    Effect.tryPromise({
      try: () => canonicalWorktreePath(value),
      catch: (cause) =>
        createGitCommandError(
          "GitCore.identity",
          value,
          [],
          "Cannot resolve checkout identity.",
          cause,
        ),
    });

  const isDirty: GitCoreShape["isDirty"] = (cwd) =>
    executeGit(
      "GitCore.isDirty",
      cwd,
      ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=normal"],
      { timeoutMs: 5_000 },
    ).pipe(
      Effect.map((result) => result.stdout.length > 0),
      Effect.catch(() => Effect.succeed(null)),
    );

  const readWorktreeEntries = (cwd: string) =>
    Effect.gen(function* () {
      const args = ["worktree", "list", "--porcelain"];
      const result = yield* executeGit("GitCore.listWorktrees", cwd, [...args, "-z"], {
        allowNonZeroExit: true,
        env: { LC_ALL: "C" },
      });
      let stdout = result.stdout;
      let format: "nul" | "line" = "nul";
      if (result.code !== 0) {
        // Git < 2.36 has no worktree-list NUL option. Retry only its usage
        // rejection; authentication, repository and I/O failures stay visible.
        if (
          result.code !== 129 ||
          !/unknown (?:switch|option)[^\n]*(?:-z|["'`]z["'`])/i.test(result.stderr)
        )
          return yield* createGitCommandError(
            "GitCore.listWorktrees",
            cwd,
            [...args, "-z"],
            result.stderr.trim() || "Git worktree listing failed.",
          );
        stdout = (yield* executeGit("GitCore.listWorktrees.legacy", cwd, args, {
          env: { LC_ALL: "C" },
        })).stdout;
        format = "line";
      }
      return parseWorktreeListPorcelain(stdout, format);
    });
  const listWorktrees: GitCoreShape["listWorktrees"] = (cwd) =>
    readWorktreeEntries(cwd).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (entry) =>
            inspectionSemaphore
              .withPermits(1)(canonicalPath(entry.path))
              .pipe(Effect.map((canonicalPath) => ({ ...entry, canonicalPath }))),
          { concurrency: 4 },
        ),
      ),
    );

  const releaseFailedWorktreeAllocation = (
    receipt: WorktreePreparationReceipt,
    cwd: string,
    path: string,
  ) =>
    Effect.gen(function* () {
      if (yield* checkoutExists(path)) return;
      if ((yield* listWorktrees(cwd)).some((entry) => entry.canonicalPath === receipt.path)) return;
      yield* preparations.update(receipt, {
        phase: "skipped",
        error: "Worktree add failed without creating a checkout.",
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const ensureWorktree: GitCoreShape["ensureWorktree"] = (input) =>
    withWorktreeLifecycleLock(
      input.path,
      Effect.gen(function* () {
        if (isUnsafeRefArgument(input.branch))
          return yield* createGitCommandError(
            "GitCore.ensureWorktree",
            input.cwd,
            [],
            "Invalid worktree ref name.",
          );
        const target = yield* canonicalPath(input.path);
        const entries = yield* listWorktrees(input.cwd);
        const registration = entries.find((entry) => entry.canonicalPath === target);
        if (yield* checkoutExists(input.path)) {
          const inspected = yield* inspectCheckoutIdentity(input.path);
          const common = yield* canonicalPath(yield* resolveCommonDir(input.cwd));
          if (
            !registration ||
            registration.isMain ||
            inspected.canonicalRoot !== target ||
            inspected.commonDir !== common ||
            inspected.branch !== input.branch ||
            registration.branch !== input.branch
          ) {
            return yield* createGitCommandError(
              "GitCore.ensureWorktree",
              input.cwd,
              [],
              "The target is not the registered checkout of the expected repository and branch.",
            );
          }
          return { recreated: false };
        }
        return yield* withRepositoryLock(
          "GitCore.ensureWorktree",
          input.cwd,
          Effect.gen(function* () {
            // Another profile may have registered the branch while we waited.
            const entries = yield* listWorktrees(input.cwd);
            const registration = entries.find((entry) => entry.canonicalPath === target);
            if (yield* checkoutExists(input.path))
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                "The target appeared during recreation. Retry verification.",
              );
            const managedRoot = yield* canonicalPath(worktreesDir);
            const relative = relativePath(managedRoot, target);
            if (
              !isAbsolutePath(input.path) ||
              !relative ||
              relative === ".." ||
              relative.startsWith("../") ||
              relative.startsWith("..\\") ||
              isAbsolutePath(relative)
            ) {
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                "Missing worktrees can only be recreated inside this profile's managed worktrees directory.",
              );
            }
            if (!(yield* branchExists(input.cwd, input.branch))) {
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                `Worktree branch ${input.branch} is missing.`,
              );
            }
            if (
              registration &&
              (registration.branch !== input.branch ||
                registration.isMain ||
                registration.locked !== null)
            ) {
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                "The missing worktree registration does not match the requested branch or is locked.",
              );
            }
            const other = entries.find(
              (entry) => entry.canonicalPath !== target && entry.branch === input.branch,
            );
            if (other)
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                `Branch ${input.branch} is checked out at ${other.path}.`,
              );
            yield* clearMissingRegistrationUnlocked(input.cwd, input.path);
            const prior = yield* preparations
              .latest(target)
              .pipe(
                Effect.mapError((error) =>
                  createGitCommandError("GitCore.ensureWorktree", input.cwd, [], error.message),
                ),
              );
            const baseOid = yield* resolveCommit(input.cwd, input.branch);
            if (!baseOid)
              return yield* createGitCommandError(
                "GitCore.ensureWorktree",
                input.cwd,
                [],
                "The branch has no commit.",
              );
            // Recreation creates a new checkout, and consequently a new preparation receipt.
            if (prior && !["completed", "skipped"].includes(prior.phase))
              yield* preparations
                .update(prior, {
                  phase: "skipped",
                  error: "Checkout disappeared; recreation superseded this attempt.",
                })
                .pipe(
                  Effect.mapError((error) =>
                    createGitCommandError("GitCore.ensureWorktree", input.cwd, [], error.message),
                  ),
                );
            const receipt = yield* preparations
              .allocate({
                operationId: crypto.randomUUID(),
                repositoryIdentity: yield* canonicalPath(yield* resolveCommonDir(input.cwd)),
                projectIdentity: yield* canonicalPath(input.cwd),
                owner: input.owner ?? prior?.owner ?? `recreation:${input.branch}`,
                requestedBase: input.branch,
                baseOid,
                path: target,
                branch: input.branch,
                namingIntent: "existing",
                // A new checkout adopts the current opted-in script during preparation.
                setupIdentity: null,
                runSetupScript: prior?.runSetupScript ?? true,
              })
              .pipe(
                Effect.mapError((error) =>
                  createGitCommandError("GitCore.ensureWorktree", input.cwd, [], error.message),
                ),
              );
            yield* executeGit(
              "GitCore.ensureWorktree",
              input.cwd,
              ["worktree", "add", "--", input.path, input.branch],
              { timeoutMs: 300_000 },
            ).pipe(
              Effect.tapError(() =>
                releaseFailedWorktreeAllocation(receipt, input.cwd, input.path),
              ),
            );
            yield* preparations
              .update(receipt, { phase: "checkout_created", createdCheckout: true })
              .pipe(
                Effect.mapError((error) =>
                  createGitCommandError("GitCore.ensureWorktree", input.cwd, [], error.message),
                ),
              );
            return { recreated: true };
          }),
        );
      }),
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(GitCommandError)(error)
          ? error
          : createGitCommandError(
              "GitCore.ensureWorktree",
              input.cwd,
              [],
              error instanceof Error ? error.message : String(error),
            ),
      ),
    );

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
        changeRequest: null,
      })),
    );

  interface PreparedIndexSnapshot {
    readonly cwd: string;
    readonly head: string | null;
    readonly indexFingerprint: string;
    readonly includedTree: string;
    readonly filePaths: readonly string[] | undefined;
  }
  const preparedContexts = new WeakMap<GitPreparedCommitContext, PreparedIndexSnapshot>();
  const readIndex = (cwd: string, indexPath: string) =>
    Effect.tryPromise({
      try: () =>
        readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      catch: (cause) =>
        createGitCommandError(
          "GitCore.readCommitIndex",
          cwd,
          [],
          "Cannot read the repository index.",
          cause,
        ),
    });
  // Hashes what the index stages, not its bytes: `git status` from an IDE or another CLI
  // rewrites the index to refresh stat data while staging stays the same. Streamed, since an
  // ordinary repository's listing can exceed the buffered output cap.
  const indexFingerprint = (cwd: string) =>
    Effect.gen(function* () {
      const hash = createHash("sha256");
      yield* git.execute({
        operation: "GitCore.commitIndex.fingerprint",
        cwd,
        args: ["ls-files", "--stage", "-z"],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        onStdoutChunk: (chunk) => {
          hash.update(chunk);
        },
      });
      return hash.digest("hex");
    });

  // Temporary indexes live beside the real index so split-index dependencies can
  // be resolved and materialized before staging. No repository lock spans generation.
  const withPreparedIndex = <A>(
    cwd: string,
    filePaths: readonly string[] | undefined,
    use: (env: NodeJS.ProcessEnv) => Effect.Effect<A, GitCommandError>,
  ) =>
    Effect.gen(function* () {
      const rawPath = yield* runGitStdout("GitCore.commitIndex.path", cwd, [
        "rev-parse",
        "--git-path",
        "index",
      ]);
      const indexPath = resolvePath(cwd, stripPathTerminator(rawPath));
      const head = yield* resolveCommit(cwd, "HEAD");
      const fingerprint = yield* indexFingerprint(cwd);
      const originalIndex = yield* readIndex(cwd, indexPath);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => `${indexPath}.f5-${crypto.randomUUID()}`),
        (temporaryIndex) =>
          Effect.gen(function* () {
            const env = { GIT_INDEX_FILE: temporaryIndex, GIT_OPTIONAL_LOCKS: "0" };
            const temporaryGit = (args: readonly string[]) =>
              executeGit(
                "GitCore.commitIndex",
                cwd,
                [
                  ...gitConfigArgs([
                    ["core.splitIndex", "false"],
                    ["splitIndex.sharedIndexExpire", "never"],
                  ]),
                  ...args,
                ],
                { env },
              );
            if (originalIndex !== null) {
              yield* Effect.tryPromise({
                try: async () => {
                  const originalStat = await stat(indexPath);
                  await writeFile(temporaryIndex, originalIndex, { flag: "wx", mode: 0o600 });
                  // Copying an index with a fresh timestamp hides same-size edits
                  // made in the original index's timestamp window. Preserve its
                  // second before Git reads or rewrites the copy.
                  const indexTime = copiedIndexTimestampSeconds(originalStat.mtime);
                  await utimes(temporaryIndex, indexTime, indexTime);
                },
                catch: (cause) =>
                  createGitCommandError(
                    "GitCore.commitIndex",
                    cwd,
                    [],
                    "Cannot create a temporary index.",
                    cause,
                  ),
              });
              yield* temporaryGit(["update-index", "--no-split-index"]);
            } else {
              yield* temporaryGit(head ? ["read-tree", head] : ["read-tree", "--empty"]);
            }
            yield* temporaryGit([
              "add",
              "-A",
              ...(filePaths?.length ? ["--", ...filePaths.map(literalGitPathspec)] : []),
            ]);
            const includedTree = (yield* temporaryGit(["write-tree"])).stdout.trim();
            const result = yield* use(env);
            const stable =
              head === (yield* resolveCommit(cwd, "HEAD")) &&
              fingerprint === (yield* indexFingerprint(cwd));
            return {
              result,
              stable,
              snapshot: {
                cwd,
                head,
                indexFingerprint: fingerprint,
                includedTree,
                filePaths: filePaths ? [...filePaths] : undefined,
              } satisfies PreparedIndexSnapshot,
            };
          }),
        (temporaryIndex) =>
          Effect.promise(async () => {
            await Promise.all([
              rm(temporaryIndex, { force: true }),
              rm(`${temporaryIndex}.lock`, { force: true }),
            ]);
          }).pipe(Effect.ignoreCause({ log: true })),
      );
    });

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd, filePaths) =>
    Effect.gen(function* () {
      const prepared = yield* withPreparedIndex(cwd, filePaths, (env) =>
        Effect.gen(function* () {
          const paths = filePaths?.length ? ["--", ...filePaths.map(literalGitPathspec)] : [];
          const stagedSummary = (yield* executeGit(
            "GitCore.prepareCommitContext.stagedSummary",
            cwd,
            ["diff", "--cached", "--name-status", ...paths],
            { env },
          )).stdout.trim();
          if (!stagedSummary) return null;
          const stagedPatch = (yield* executeGit(
            "GitCore.prepareCommitContext.stagedPatch",
            cwd,
            [
              "diff",
              "--cached",
              "--patch",
              "--find-renames",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--minimal",
              ...paths,
            ],
            { env },
          )).stdout;
          return { stagedSummary, stagedPatch };
        }),
      );
      if (!prepared.stable)
        return yield* createGitCommandError(
          "GitCore.prepareCommitContext",
          cwd,
          [],
          "The repository changed while reading commit context. Try again.",
        );
      if (prepared.result) preparedContexts.set(prepared.result, prepared.snapshot);
      return prepared.result;
    });

  const commitPrepared: GitCoreShape["commitPrepared"] = (cwd, subject, body, context, options) =>
    withRepositoryLock(
      "GitCore.commitPrepared",
      cwd,
      Effect.gen(function* () {
        const expected = preparedContexts.get(context);
        if (!expected || expected.cwd !== cwd)
          return yield* createGitCommandError(
            "GitCore.commitPrepared",
            cwd,
            [],
            "This commit context is unavailable. Generate a new suggestion.",
          );
        // Reading a new temporary index also catches edits to included worktree
        // content. Never copy an earlier index back over another client's staging.
        if (
          expected.head !== (yield* resolveCommit(cwd, "HEAD")) ||
          expected.indexFingerprint !== (yield* indexFingerprint(cwd))
        )
          return { status: "context_changed" as const };
        const current = yield* withPreparedIndex(cwd, expected.filePaths, () => Effect.void).pipe(
          // A removed selected path or a newly conflicted index cannot be safely
          // rebuilt. Keep the suggestion and leave staging untouched for review.
          Effect.catch(() => Effect.succeed(null)),
        );
        if (
          !current ||
          !current.stable ||
          current.snapshot.head !== expected.head ||
          current.snapshot.indexFingerprint !== expected.indexFingerprint ||
          current.snapshot.includedTree !== expected.includedTree
        )
          return { status: "context_changed" as const };
        if (options?.newBranch) {
          yield* createBranch({ cwd, branch: options.newBranch });
          yield* Effect.scoped(checkoutBranch({ cwd, branch: options.newBranch }));
        }
        yield* runGit("GitCore.commitPrepared.stage", cwd, [
          "add",
          "-A",
          ...(expected.filePaths?.length
            ? ["--", ...expected.filePaths.map(literalGitPathspec)]
            : []),
        ]);
        const result = yield* commit(cwd, subject, body, expected.filePaths);
        preparedContexts.delete(context);
        return { status: "created" as const, commitSha: result.commitSha };
      }),
    );

  const commit: GitCoreShape["commit"] = (cwd, subject, body, filePaths) =>
    Effect.gen(function* () {
      const args = ["commit", "-m", subject];
      const trimmedBody = body.trim();
      if (trimmedBody.length > 0) {
        args.push("-m", trimmedBody);
      }
      if (filePaths && filePaths.length > 0) {
        const mergeHeadPath = yield* runGitStdout("GitCore.commit.mergeHeadPath", cwd, [
          "rev-parse",
          "--git-path",
          "MERGE_HEAD",
        ]).pipe(Effect.map((stdout) => stdout.trim()));
        const mergeInProgress = yield* fileSystem
          .exists(isAbsolutePath(mergeHeadPath) ? mergeHeadPath : resolvePath(cwd, mergeHeadPath))
          .pipe(Effect.catch(() => Effect.succeed(false)));
        if (!mergeInProgress) {
          args.push("--only", "--", ...filePaths.map(literalGitPathspec));
        }
      }
      yield* runGit("GitCore.commit.commit", cwd, args);
      const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha };
    });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* executeGit(
          "GitCore.pushCurrentBranch.pushWithUpstream",
          cwd,
          ["push", "-u", "--", publishRemoteName, `HEAD:refs/heads/${branch}`],
          { timeoutMs: 15 * 60_000 },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: true,
        };
      }

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        // Git may retain part of a slash-containing remote name in a tracking alias.
        const isAliasOfUpstreamHead =
          branch === currentUpstream.upstreamBranch ||
          isPullRequestTrackingAlias(branch, currentUpstream.upstreamBranch) ||
          (branch.endsWith(`/${currentUpstream.upstreamBranch}`) &&
            currentUpstream.upstreamRef.endsWith(`/${branch}`));
        if (!isAliasOfUpstreamHead) {
          const remoteName = yield* resolvePushRemoteName(cwd, branch, currentUpstream.remoteName);
          const mergeBaseKey = `branch.${branch}.gh-merge-base`;
          const configuredBase = yield* runGitStdout(
            "GitCore.pushCurrentBranch.readMergeBase",
            cwd,
            ["config", "--get", "--", mergeBaseKey],
            true,
          );
          if (!configuredBase.trim())
            yield* runGit("GitCore.pushCurrentBranch.recordMergeBase", cwd, [
              "config",
              "--",
              mergeBaseKey,
              currentUpstream.upstreamBranch,
            ]);
          yield* executeGit(
            "GitCore.pushCurrentBranch.pushOwnBranch",
            cwd,
            ["push", "-u", "--", remoteName!, `HEAD:refs/heads/${branch}`],
            { timeoutMs: 15 * 60_000 },
          );
          return {
            status: "pushed" as const,
            branch,
            upstreamBranch: `${remoteName}/${branch}`,
            setUpstream: true,
          };
        }
        yield* executeGit(
          "GitCore.pushCurrentBranch.pushUpstream",
          cwd,
          [
            "push",
            "--",
            currentUpstream.remoteName,
            `HEAD:refs/heads/${currentUpstream.upstreamBranch}`,
          ],
          { timeoutMs: 15 * 60_000 },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      yield* executeGit("GitCore.pushCurrentBranch.push", cwd, ["push"], {
        timeoutMs: 15 * 60_000,
      });
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    });

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      // Serialized with automatic default-branch pulls in other F5 profiles.
      yield* withRepositoryLock(
        "GitCore.pullCurrentBranch",
        cwd,
        // HEAD before and after decides the result, so the output is not needed. A large
        // fast-forward's diffstat can exceed the output cap, which must not fail a pull Git applied.
        executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
          timeoutMs: 30_000,
          fallbackErrorMessage: "git pull failed",
          onStdoutChunk: discardOutputChunk,
          onStderrChunk: discardOutputChunk,
        }),
      );
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    });

  const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
    Effect.gen(function* () {
      const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const remoteRangeBase =
        primaryRemoteName &&
        !baseBranch.startsWith(`${primaryRemoteName}/`) &&
        (yield* remoteBranchExists(cwd, primaryRemoteName, baseBranch).pipe(
          Effect.catch(() => Effect.succeed(false)),
        ))
          ? `${primaryRemoteName}/${baseBranch}`
          : baseBranch;
      const commitRange = `${remoteRangeBase}..HEAD`;
      // PR content is the change introduced since the merge base. A two-dot tree diff also
      // includes changes made only on a base branch that moved after the feature branched.
      const diffRange = `${remoteRangeBase}...HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdout("GitCore.readRangeContext.log", cwd, [
            "log",
            "--oneline",
            "--end-of-options",
            commitRange,
            "--",
          ]),
          runGitStdout("GitCore.readRangeContext.diffStat", cwd, [
            "diff",
            "--stat",
            "--end-of-options",
            diffRange,
            "--",
          ]),
          runGitStdout("GitCore.readRangeContext.diffPatch", cwd, [
            "diff",
            "--patch",
            "--find-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--minimal",
            "--end-of-options",
            diffRange,
            "--",
          ]),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    });

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", "--", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const listBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      if (
        !(yield* fileSystem
          .exists(input.cwd)
          .pipe(
            Effect.mapError((error) =>
              createGitCommandError("GitCore.listBranches", input.cwd, [], error.message),
            ),
          ))
      )
        return { branches: [], isRepo: false, hasOriginRemote: false, worktreeMissing: true };

      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const localBranchResult = yield* executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      );

      if (localBranchResult.code !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return { branches: [], isRepo: false, hasOriginRemote: false };
        }
        return yield* createGitCommandError(
          "GitCore.listBranches",
          input.cwd,
          ["branch", "--no-color"],
          stderr || "git branch failed",
        );
      }

      const remoteBranchResultEffect = executeGit(
        "GitCore.listBranches.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const staticMetadataEffect = readStatusStaticMetadata(input.cwd).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: static metadata lookup failed for ${input.cwd}: ${error.message}. Falling back to empty remote metadata.`,
          ).pipe(
            Effect.as({
              commonDir: input.cwd,
              remoteNames: [] as ReadonlyArray<string>,
              primaryRemoteName: null,
              defaultBranchName: null,
            } satisfies StatusStaticMetadata),
          ),
        ),
      );

      const [worktreeList, remoteBranchResult, staticMetadata, branchLastCommit] =
        yield* Effect.all(
          [
            listWorktrees(input.cwd),
            remoteBranchResultEffect,
            staticMetadataEffect,
            branchRecencyPromise,
          ],
          { concurrency: "unbounded" },
        );

      const remoteNames = staticMetadata.remoteNames;
      if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
        );
      }
      const defaultBranch =
        staticMetadata.primaryRemoteName === "origin" ? staticMetadata.defaultBranchName : null;

      const worktreeMap = new Map<string, string>();
      const present = yield* Effect.forEach(
        worktreeList,
        (entry) =>
          inspectionSemaphore
            .withPermits(1)(checkoutExists(entry.path))
            .pipe(Effect.map((exists) => (exists ? entry : null))),
        { concurrency: 4 },
      );
      for (const entry of present) {
        if (entry?.branch) worktreeMap.set(entry.branch, entry.path);
      }

      const localBranches = localBranchResult.stdout
        .split("\n")
        .map(parseBranchLine)
        .filter((branch): branch is { name: string; current: boolean } => branch !== null)
        .map((branch) => ({
          name: branch.name,
          current: branch.current,
          isRemote: false,
          isDefault: branch.name === defaultBranch,
          worktreePath: worktreeMap.get(branch.name) ?? null,
        }))
        .toSorted((a, b) => {
          const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
          const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aLastCommit = branchLastCommit.get(a.name) ?? 0;
          const bLastCommit = branchLastCommit.get(b.name) ?? 0;
          if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
          return a.name.localeCompare(b.name);
        });

      const remoteBranches =
        remoteBranchResult.code === 0
          ? remoteBranchResult.stdout
              .split("\n")
              .map(parseBranchLine)
              .filter((branch): branch is { name: string; current: boolean } => branch !== null)
              .map((branch) => {
                const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
                const remoteBranch: {
                  name: string;
                  current: boolean;
                  isRemote: boolean;
                  remoteName?: string;
                  isDefault: boolean;
                  worktreePath: string | null;
                } = {
                  name: branch.name,
                  current: false,
                  isRemote: true,
                  isDefault: false,
                  worktreePath: null,
                };
                if (parsedRemoteRef) {
                  remoteBranch.remoteName = parsedRemoteRef.remoteName;
                }
                return remoteBranch;
              })
              .toSorted((a, b) => {
                const aLastCommit = branchLastCommit.get(a.name) ?? 0;
                const bLastCommit = branchLastCommit.get(b.name) ?? 0;
                if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
                return a.name.localeCompare(b.name);
              })
          : [];

      const branches = [...localBranches, ...remoteBranches];

      return { branches, isRepo: true, hasOriginRemote: remoteNames.includes("origin") };
    });

  const initializeSubmodules = (
    worktreePath: string,
    submodules?: import("@t3tools/contracts").WorktreeSubmodules,
    progress?: GitWorktreeProgress,
  ) =>
    Effect.gen(function* () {
      if (submodules === "none") {
        progress?.onSubmodulesFinished?.({ status: "skipped", detail: "disabled in settings" });
        return;
      }
      const gitmodules = yield* fileSystem
        .exists(`${worktreePath}/.gitmodules`)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!gitmodules) {
        progress?.onSubmodulesFinished?.({ status: "skipped", detail: "none" });
        return;
      }
      progress?.onSubmodulesStarted?.();
      const lines = makeProgressLineSplitter((line) => progress?.onSubmoduleLine?.(line));
      yield* executeGit(
        "GitCore.createWorktree.submodules",
        worktreePath,
        [
          ...gitConfigArgs([["protocol.file.allow", "never"]]),
          "submodule",
          "update",
          "--init",
          ...((submodules ?? "recursive") === "recursive" ? ["--recursive"] : []),
        ],
        {
          timeoutMs: 300_000,
          fallbackErrorMessage: "Unable to initialize worktree submodules",
          ...(progress?.onSubmoduleLine ? { onStderrChunk: lines } : {}),
        },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => progress?.onSubmodulesFinished?.({ status: "done", detail: null })),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            progress?.onSubmodulesFinished?.({ status: "warning", detail: error.message }),
          ).pipe(
            Effect.andThen(
              Effect.logWarning("Worktree created, but submodule initialization failed", {
                error: error.message,
              }),
            ),
          ),
        ),
      );
    });

  const resolveCommonDir: GitCoreShape["resolveCommonDir"] = (cwd) =>
    runGitStdout("GitCore.resolveCommonDir", cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stripPathTerminator(stdout)));

  /** Runs a shared-repository mutation under the cross-profile lock for `cwd`'s repository. */
  const withRepositoryLock = <A>(
    operation: string,
    cwd: string,
    effect: Effect.Effect<A, GitCommandError>,
    mode: "user" | "background" = "user",
  ): Effect.Effect<A, GitCommandError> =>
    resolveCommonDir(cwd).pipe(
      Effect.flatMap((commonDir) =>
        withRepositoryLifecycleLock(baseDir, commonDir, effect, { mode }),
      ),
      Effect.mapError((error) =>
        Schema.is(GitCommandError)(error)
          ? error
          : createGitCommandError(operation, cwd, [], error.message, error),
      ),
    );

  const allocateWorktreePath: GitCoreShape["allocateWorktreePath"] = ({ cwd, branch }) =>
    Effect.gen(function* () {
      const common = yield* canonicalPath(yield* resolveCommonDir(cwd));
      const repository = basename(common) === ".git" ? basename(dirname(common)) : basename(common);
      const target = joinPath(
        worktreesDir,
        `${worktreePathSlug(repository)}-${repositoryIdentityHash(common).slice(0, 12)}`,
        `${worktreePathSlug(branch)}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`,
      );
      if (worktreePathExceedsWindowsLimit(target))
        return yield* createGitCommandError(
          "GitCore.allocateWorktreePath",
          cwd,
          [],
          "The new worktree path exceeds the Windows limit of 180 UTF-16 code units.",
        );
      const root = yield* canonicalPath(worktreesDir);
      const canonical = yield* canonicalPath(target);
      if (canonical === root || !pathContains(root, canonical))
        return yield* createGitCommandError(
          "GitCore.allocateWorktreePath",
          cwd,
          [],
          "The allocated worktree path escapes this profile's managed root.",
        );
      return target;
    });

  const isValidBranchName: GitCoreShape["isValidBranchName"] = (name) =>
    isUnsafeRefArgument(name)
      ? Effect.succeed(false)
      : executeGit("GitCore.isValidBranchName", baseDir, ["check-ref-format", "--branch", name], {
          allowNonZeroExit: true,
        }).pipe(Effect.map((result) => result.code === 0));

  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const targetBranch = input.newBranch ?? input.branch;
      const baseRefName = input.baseRefName ?? input.branch;
      // worktree add can invoke git branch internally; a terminator before
      // the path does not protect the new branch argument passed to that command.
      if (isUnsafeRefArgument(targetBranch) || isUnsafeRefArgument(baseRefName)) {
        return yield* createGitCommandError(
          "GitCore.createWorktree",
          input.cwd,
          [],
          "Invalid worktree ref name.",
        );
      }
      const worktreePath =
        input.path ?? (yield* allocateWorktreePath({ cwd: input.cwd, branch: targetBranch }));
      const operationId = input.preparation?.operationId ?? crypto.randomUUID();
      const create = Effect.gen(function* () {
        const resolvedBase = yield* runGitStdout(
          "GitCore.createWorktree.verifyBaseRef",
          input.cwd,
          ["rev-parse", "--verify", "--end-of-options", `${baseRefName}^{commit}`],
          true,
        ).pipe(
          Effect.filterOrFail(
            (stdout) => /^[0-9a-f]{40,64}$/iu.test(stdout.trim()),
            () =>
              createGitCommandError(
                "GitCore.createWorktree.verifyBaseRef",
                input.cwd,
                ["rev-parse", "--verify", "--end-of-options", `${baseRefName}^{commit}`],
                `Cannot resolve worktree base ref '${baseRefName}'.`,
              ),
          ),
        );
        const progress = input.progress;
        // `worktree add` has no --progress flag: GIT_PROGRESS_DELAY=0 makes git
        // print checkout progress even though stderr is a pipe.
        const args = [
          "worktree",
          "add",
          ...(input.newBranch ? ["-b", input.newBranch] : []),
          "--",
          worktreePath,
          baseRefName,
        ];
        // Reject occupied targets under the lifecycle lock before allocating ownership.
        const existedBefore = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        const target = yield* canonicalPath(worktreePath);
        const managedRoot = yield* canonicalPath(worktreesDir);
        // Explicit paths remain supported, but a symlink may never redirect a managed allocation.
        if (
          pathContains(resolvePath(worktreesDir), resolvePath(worktreePath)) &&
          (target === managedRoot || !pathContains(managedRoot, target))
        )
          return yield* createGitCommandError(
            "GitCore.createWorktree",
            input.cwd,
            [],
            "The worktree target escapes the managed root.",
          );
        if (!input.preparation?.replaceMissing && worktreePathExceedsWindowsLimit(worktreePath))
          return yield* createGitCommandError(
            "GitCore.createWorktree",
            input.cwd,
            [],
            "The new worktree path exceeds the Windows limit of 180 UTF-16 code units.",
          );
        if (existedBefore)
          return yield* createGitCommandError(
            "GitCore.createWorktree",
            input.cwd,
            [],
            "The worktree target is occupied. Existing files were kept; inspect the checkout before retrying.",
          );
        if (input.preparation?.replaceMissing) {
          const previous = yield* preparations
            .latest(target)
            .pipe(
              Effect.mapError((error) =>
                createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message),
              ),
            );
          if (
            previous &&
            previous.owner === input.preparation.owner &&
            !["completed", "skipped"].includes(previous.phase)
          )
            yield* preparations
              .update(previous, {
                phase: "skipped",
                error: "Explicit recovery replaced a verified missing checkout.",
              })
              .pipe(
                Effect.mapError((error) =>
                  createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message),
                ),
              );
        }
        const receipt = yield* preparations
          .allocate({
            operationId,
            repositoryIdentity: yield* canonicalPath(yield* resolveCommonDir(input.cwd)),
            projectIdentity: yield* canonicalPath(input.preparation?.projectCwd ?? input.cwd),
            owner: input.preparation?.owner ?? `raw:${targetBranch}`,
            requestedBase: input.preparation?.requestedBase ?? input.branch,
            baseOid: resolvedBase.trim(),
            path: target,
            branch: targetBranch,
            namingIntent:
              input.preparation?.namingIntent ?? (input.newBranch ? "temporary" : "existing"),
            setupIdentity: input.preparation?.setupIdentity ?? null,
            runSetupScript: input.preparation?.runSetupScript ?? false,
          })
          .pipe(
            Effect.mapError((error) =>
              createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message, error),
            ),
          );
        let claimed = false;
        const claim = () => {
          if (claimed) return;
          claimed = true;
          progress?.onWorktreeClaimed?.(worktreePath);
        };
        yield* executeGit("GitCore.createWorktree", input.cwd, args, {
          timeoutMs: 300_000,
          fallbackErrorMessage: "git worktree add failed",
          ...(progress
            ? {
                env: { ...process.env, GIT_PROGRESS_DELAY: "0", LC_ALL: "C" },
                onStderrChunk: makeProgressLineSplitter((line) => {
                  // "Preparing worktree" is printed once git has registered the path.
                  if (line.startsWith("Preparing worktree")) claim();
                  const checkout = parseCheckoutProgressLine(line);
                  if (checkout) {
                    claim();
                    progress.onCheckoutProgress?.(checkout);
                  }
                }),
              }
            : {}),
        }).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              if (yield* checkoutExists(worktreePath)) claim();
              else yield* releaseFailedWorktreeAllocation(receipt, input.cwd, worktreePath);
            }).pipe(Effect.ignoreCause({ log: true })),
          ),
        );
        yield* preparations
          .update(receipt, { phase: "checkout_created", createdCheckout: true })
          .pipe(
            // Submodule initialization runs outside locks but still owns the checkout.
            Effect.flatMap((created) => preparations.update(created, { phase: "setup_running" })),
            Effect.mapError((error) =>
              createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message, error),
            ),
          );
        // A successful add proves that this operation created the checkout.
        claim();
      });
      yield* withWorktreeLifecycleLock(
        worktreePath,
        withRepositoryLock("GitCore.createWorktree", input.cwd, create),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(GitCommandError)(error)
            ? error
            : createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message),
        ),
      );

      const finishInitialization = (error: string | null) =>
        withWorktreeLifecycleLock(
          worktreePath,
          Effect.gen(function* () {
            const receipt = yield* preparations.latest(yield* canonicalPath(worktreePath));
            if (
              !receipt ||
              receipt.operationId !== operationId ||
              receipt.phase !== "setup_running"
            )
              return yield* createGitCommandError(
                "GitCore.createWorktree",
                input.cwd,
                [],
                "Preparation changed during submodule initialization.",
              );
            yield* preparations.update(receipt, {
              phase: error
                ? "setup_failed"
                : input.preparation?.runSetupScript
                  ? "checkout_created"
                  : "skipped",
              error,
              result: error ? null : JSON.stringify({ path: worktreePath, branch: targetBranch }),
            });
          }),
        ).pipe(
          Effect.mapError((error) =>
            Schema.is(GitCommandError)(error)
              ? error
              : createGitCommandError("GitCore.createWorktree", input.cwd, [], error.message),
          ),
        );
      yield* initializeSubmodules(worktreePath, input.submodules, input.progress).pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? finishInitialization(
                "Submodule initialization did not finish. Retry preparation.",
              ).pipe(Effect.ignoreCause({ log: true }))
            : Effect.void,
        ),
      );
      yield* finishInitialization(null);
      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    });

  const resolveCommit: GitCoreShape["resolveCommit"] = (cwd, revision) =>
    executeGit(
      "GitCore.resolveCommit",
      cwd,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        const sha = result.stdout.trim();
        return result.code === 0 && /^[0-9a-f]{40,64}$/iu.test(sha) ? sha : null;
      }),
    );

  const OPERATION_MARKERS = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ] as const;

  const readOperationInProgress: GitCoreShape["readOperationInProgress"] = (cwd) =>
    Effect.forEach(
      OPERATION_MARKERS,
      ([marker, operation]) =>
        runGitStdout("GitCore.readOperationInProgress", cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          marker,
        ]).pipe(
          Effect.flatMap((stdout) => fileSystem.exists(stripPathTerminator(stdout))),
          Effect.map((present) => (present ? operation : null)),
          Effect.mapError((error) =>
            Schema.is(GitCommandError)(error)
              ? error
              : createGitCommandError(
                  "GitCore.readOperationInProgress",
                  cwd,
                  [],
                  "Cannot inspect operation markers.",
                  error,
                ),
          ),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((found) => found.find((operation) => operation !== null) ?? null));

  const inspectCheckoutIdentity: GitCoreShape["inspectCheckoutIdentity"] = (cwd) =>
    inspectionSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* runGitStdout("GitCore.inspectCheckoutIdentity", cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
        ]);
        const symbolic = yield* executeGit(
          "GitCore.inspectCheckoutIdentity",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowNonZeroExit: true },
        );
        if (symbolic.code !== 0 && symbolic.code !== 1)
          return yield* createGitCommandError(
            "GitCore.inspectCheckoutIdentity",
            cwd,
            [],
            "Cannot inspect symbolic HEAD.",
          );
        return {
          canonicalRoot: yield* canonicalPath(stripPathTerminator(root)),
          commonDir: yield* canonicalPath(yield* resolveCommonDir(cwd)),
          branch: symbolic.code === 0 ? stripPathTerminator(symbolic.stdout) : null,
        };
      }),
    );

  const cleanupSafetyProbe = (
    cwd: string,
    statusTimeoutMs?: number,
  ): ReturnType<GitCoreShape["cleanupSafetyProbe"]> =>
    Effect.gen(function* () {
      const { stdout } = yield* executeGit(
        "GitCore.cleanupSafetyProbe",
        cwd,
        [
          "--no-optional-locks",
          ...gitConfigArgs([["status.showUntrackedFiles", "all"]]),
          "status",
          "--porcelain=2",
          "-z",
          "--untracked-files=all",
          "--ignored=no",
        ],
        { timeoutMs: statusTimeoutMs ?? 30_000 },
      );
      const status = yield* Effect.try({
        try: () => parseCleanupSafetyStatus(stdout),
        catch: () =>
          createGitCommandError(
            "GitCore.cleanupSafetyProbe",
            cwd,
            [],
            "Cannot verify cleanup status.",
          ),
      });
      // Collapsing ignored folders avoids expanding dependency trees into
      // megabytes of status output. A separate pathspec reaches protected
      // files even when their parent directory itself is ignored.
      const ignored = yield* readIgnoredEntries(cwd, ["--directory"], statusTimeoutMs);
      const protectedIgnored = yield* readIgnoredEntries(
        cwd,
        ["--", ":(glob)**/.env", ":(glob)**/.env.*", ":(glob)**/.env/**", ":(glob)**/.env.*/**"],
        statusTimeoutMs,
      );
      return {
        ...status,
        ignoredEntries: [...new Set([...ignored.entries, ...protectedIgnored.entries])],
        ignoredTruncated: ignored.truncated || protectedIgnored.truncated,
      };
    });

  const inspectCheckout: GitCoreShape["inspectCheckout"] = (cwd, options) =>
    fullInspectionSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* runGitStdout("GitCore.inspectCheckout", cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
        ]);
        const canonicalRoot = yield* canonicalPath(stripPathTerminator(root));
        const commonDir = yield* canonicalPath(yield* resolveCommonDir(cwd));
        // Avoid recursively acquiring the inspection semaphore while listing registrations.
        const listed = yield* readWorktreeEntries(cwd);
        const entries = yield* Effect.forEach(listed, (entry) =>
          canonicalPath(entry.path).pipe(
            Effect.map((canonicalPath) => ({ ...entry, canonicalPath })),
          ),
        );
        const symbolic = yield* executeGit(
          "GitCore.inspectCheckout",
          cwd,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowNonZeroExit: true },
        );
        if (symbolic.code !== 0 && symbolic.code !== 1)
          return yield* createGitCommandError(
            "GitCore.inspectCheckout",
            cwd,
            [],
            "Cannot inspect symbolic HEAD.",
          );
        // Stream the index: ordinary repositories can exceed the buffered output cap.
        // Retain only gitlinks and the current (possibly split) NUL-delimited record.
        const gitlinks: string[] = [];
        const indexFingerprint =
          options?.recoveryFingerprint || options?.changesFingerprint ? createHash("sha256") : null;
        const decoder = new TextDecoder();
        let pending = "";
        yield* git.execute({
          operation: "GitCore.inspectCheckout.submodules",
          cwd,
          args: ["ls-files", "--stage", "-z"],
          onStdoutChunk: (chunk) => {
            indexFingerprint?.update(chunk);
            const records = (pending + decoder.decode(chunk, { stream: true })).split("\0");
            pending = records.pop()!;
            for (const entry of records)
              if (entry.startsWith("160000 ")) gitlinks.push(entry.slice(entry.indexOf("\t") + 1));
          },
        });
        if (pending.length || decoder.decode().length)
          return yield* createGitCommandError(
            "GitCore.inspectCheckout",
            cwd,
            [],
            "Incomplete index inspection.",
          );
        const populated = yield* Effect.forEach(
          gitlinks,
          (path) =>
            fileSystem
              .exists(joinPath(cwd, path, ".git"))
              .pipe(
                Effect.mapError((error) =>
                  createGitCommandError("GitCore.inspectCheckout", cwd, [], error.message),
                ),
              ),
          { concurrency: 4 },
        );
        const hasInitializedSubmodules = populated.some(Boolean);
        const safety = yield* cleanupSafetyProbe(cwd, options?.statusTimeoutMs);
        const { hasTrackedChanges, hasUntrackedChanges } = safety;
        const status = indexFingerprint
          ? (yield* executeGit(
              "GitCore.inspectCheckout",
              cwd,
              [
                "--no-optional-locks",
                ...gitConfigArgs([["status.showUntrackedFiles", "all"]]),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
              ],
              { timeoutMs: options?.statusTimeoutMs ?? 30_000 },
            )).stdout
          : "";
        const changedPaths: string[] = [];
        const untrackedPaths: string[] = [];
        const records = status.split("\0");
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!;
          if (!record) continue;
          changedPaths.push(record.slice(3));
          if (record.startsWith("??")) untrackedPaths.push(record.slice(3));
          if (!record.startsWith("??")) {
            if (/^[RC]|^.[RC]/.test(record)) {
              if (records[i + 1]) changedPaths.push(records[i + 1]!);
              i++;
            }
          }
        }
        const indexDigest = indexFingerprint?.digest() ?? new Uint8Array();
        // Only the changed paths: ignored build output can hold far more files than fit the
        // budget. The index is included so content staged after review is detected too.
        const changesFingerprint = options?.changesFingerprint
          ? yield* Effect.tryPromise({
              try: () => checkoutFingerprint(cwd, changedPaths, indexDigest, status),
              catch: (cause) =>
                createGitCommandError("GitCore.inspectCheckout", cwd, [], String(cause)),
            })
          : null;
        if (options?.recoveryFingerprint && safety.ignoredTruncated)
          return yield* createGitCommandError(
            "GitCore.inspectCheckout",
            cwd,
            [],
            "The ignored-file listing is incomplete; recovery inspection cannot verify all local files.",
          );
        const localFingerprint = options?.recoveryFingerprint
          ? yield* Effect.tryPromise({
              try: () =>
                checkoutFingerprint(
                  cwd,
                  [...changedPaths, ...safety.ignoredEntries],
                  indexDigest,
                  status,
                ),
              catch: (cause) =>
                createGitCommandError("GitCore.inspectCheckout", cwd, [], String(cause)),
            })
          : null;

        const upstream = yield* executeGit(
          "GitCore.inspectCheckout",
          cwd,
          ["rev-parse", "--symbolic-full-name", "@{upstream}"],
          { allowNonZeroExit: true },
        );
        const upstreamRef = upstream.code === 0 ? stripPathTerminator(upstream.stdout) : null;
        const upstreamSha = upstreamRef ? yield* resolveCommit(cwd, upstreamRef) : null;
        const aheadSha = options?.aheadOf
          ? yield* resolveCommit(cwd, options.aheadOf)
          : upstreamSha;
        const aheadCount = aheadSha
          ? Number(
              stripPathTerminator(
                yield* runGitStdout("GitCore.inspectCheckout", cwd, [
                  "rev-list",
                  "--count",
                  "--end-of-options",
                  `${aheadSha}..HEAD`,
                  "--",
                ]),
              ),
            )
          : null;
        return {
          ...(localFingerprint ? { localFingerprint } : {}),
          canonicalRoot,
          commonDir,
          registration: entries.find((entry) => entry.canonicalPath === canonicalRoot) ?? null,
          headSha: yield* resolveCommit(cwd, "HEAD"),
          branch: symbolic.code === 0 ? stripPathTerminator(symbolic.stdout) : null,
          operation: yield* readOperationInProgress(cwd),
          hasInitializedSubmodules,
          hasTrackedChanges,
          hasUntrackedChanges,
          changedPaths,
          untrackedPaths,
          ...(changesFingerprint ? { changesFingerprint } : {}),
          ignoredEntries: safety.ignoredEntries,
          ignoredTruncated: safety.ignoredTruncated,
          upstreamRef,
          upstreamSha,
          aheadCount,
          behindCount: aheadSha
            ? Number(
                stripPathTerminator(
                  yield* runGitStdout("GitCore.inspectCheckout", cwd, [
                    "rev-list",
                    "--count",
                    "--end-of-options",
                    `HEAD..${aheadSha}`,
                    "--",
                  ]),
                ),
              )
            : null,
        };
      }),
    );

  const isAncestor: GitCoreShape["isAncestor"] = (cwd, ancestor, descendant) =>
    executeGit(
      "GitCore.isAncestor",
      cwd,
      ["merge-base", "--is-ancestor", "--", ancestor, descendant],
      {
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(true)
          : result.code === 1
            ? Effect.succeed(false)
            : Effect.fail(
                createGitCommandError(
                  "GitCore.isAncestor",
                  cwd,
                  ["merge-base", "--is-ancestor"],
                  result.stderr.trim() || `merge-base exited with ${result.code}`,
                ),
              ),
      ),
    );

  const deleteBranchIfAt: GitCoreShape["deleteBranchIfAt"] = (input) =>
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.expectedSha) || /^0+$/.test(input.expectedSha)
      ? Effect.succeed(false)
      : withRepositoryLock(
          "GitCore.deleteBranchIfAt",
          input.cwd,
          Effect.gen(function* () {
            if (
              input.onlyIfUnused &&
              (yield* readWorktreeEntries(input.cwd)).some((entry) => entry.branch === input.branch)
            )
              return false;
            return yield* executeGit(
              "GitCore.deleteBranchIfAt",
              input.cwd,
              [
                "update-ref",
                "--no-deref",
                "-d",
                "--",
                `refs/heads/${input.branch}`,
                input.expectedSha,
              ],
              { allowNonZeroExit: true },
            ).pipe(Effect.map((result) => result.code === 0));
          }),
        );

  const readFileAtRevision: GitCoreShape["readFileAtRevision"] = (input) =>
    executeGit(
      "GitCore.readFileAtRevision",
      input.cwd,
      ["cat-file", "-s", "--", `${input.revision}:${input.path}`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.flatMap((size) => {
        const bytes = Number(size.stdout.trim());
        if (size.code !== 0 || !Number.isFinite(bytes) || bytes > input.maxBytes) {
          return Effect.succeed(null);
        }
        return executeGit(
          "GitCore.readFileAtRevision",
          input.cwd,
          ["cat-file", "blob", "--", `${input.revision}:${input.path}`],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((blob) => (blob.code === 0 ? blob.stdout : null)));
      }),
    );

  const IGNORED_LISTING_MAX_BYTES = 64 * 1024;
  const readIgnoredEntries = (cwd: string, suffix: ReadonlyArray<string>, timeoutMs = 30_000) =>
    git
      .execute({
        operation: "GitCore.listIgnoredEntries",
        cwd,
        args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", ...suffix],
        maxOutputBytes: IGNORED_LISTING_MAX_BYTES,
        timeoutMs,
      })
      .pipe(
        Effect.map((result) => ({
          entries: result.stdout.split("\0").filter((entry) => entry.length > 0),
          truncated: false,
        })),
        Effect.catch((error) =>
          error.detail.includes("output exceeded")
            ? Effect.succeed({ entries: [], truncated: true })
            : Effect.fail(error),
        ),
      );

  const listIgnoredEntries: GitCoreShape["listIgnoredEntries"] = (cwd) =>
    readIgnoredEntries(cwd, ["--directory"]);

  const pruneWorktrees: GitCoreShape["pruneWorktrees"] = (cwd) =>
    withRepositoryLock(
      "GitCore.pruneWorktrees",
      cwd,
      runGit("GitCore.pruneWorktrees", cwd, ["worktree", "prune"]),
    );

  const fetchRemoteBranchCommit: GitCoreShape["fetchRemoteBranchCommit"] = (input) =>
    Effect.gen(function* () {
      const remoteName = input.remoteName?.trim() || (yield* resolvePrimaryRemoteName(input.cwd));
      if (remoteName.startsWith("-") || remoteName.includes("\0")) {
        return yield* createGitCommandError(
          "GitCore.fetchRemoteBranchCommit.validateRemote",
          input.cwd,
          ["fetch", remoteName],
          `Invalid remote name '${remoteName}'.`,
        );
      }
      const branch = input.branch.startsWith(`${remoteName}/`)
        ? input.branch.slice(remoteName.length + 1)
        : input.branch;
      yield* executeGit(
        "GitCore.fetchRemoteBranchCommit.validateBranch",
        input.cwd,
        ["check-ref-format", `refs/heads/${branch}`],
        { fallbackErrorMessage: `Invalid remote branch '${input.branch}'` },
      );

      if (input.allowMissingBranch) {
        const probe = yield* executeGit(
          "GitCore.fetchRemoteBranchCommit.probe",
          input.cwd,
          ["ls-remote", "--exit-code", "--heads", "--", remoteName, `refs/heads/${branch}`],
          { allowNonZeroExit: true },
        );
        if (probe.code === 2) return null;
        if (probe.code !== 0) {
          return yield* createGitCommandError(
            "GitCore.fetchRemoteBranchCommit.probe",
            input.cwd,
            ["ls-remote"],
            networkFailureDetail(probe.stderr),
          );
        }
      }

      const fullRefName = `refs/remotes/${remoteName}/${branch}`;
      const fetchArgs = [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        remoteName,
        `+refs/heads/${branch}:${fullRefName}`,
      ];
      const fetchOptions = {
        timeoutMs: 30_000,
        env: {
          ...process.env,
          ...BACKGROUND_GIT_FETCH_ENV,
        },
        fallbackErrorMessage: `Failed to fetch ${remoteName}/${branch}`,
      };
      // Another fetch in this repository, such as the background status poll, can win
      // the race for the remote-tracking ref. The ref is free again by the time a rerun
      // needs it, so retry once before failing.
      const fetchOnce = () =>
        executeGit("GitCore.fetchRemoteBranchCommit.fetch", input.cwd, fetchArgs, {
          ...fetchOptions,
          allowNonZeroExit: true,
        });
      let fetched = yield* fetchOnce();
      if (fetched.code !== 0 && isRefLockFailure(fetched.stderr)) fetched = yield* fetchOnce();
      if (fetched.code !== 0) {
        return yield* createGitCommandError(
          "GitCore.fetchRemoteBranchCommit.fetch",
          input.cwd,
          fetchArgs.map((argument) =>
            argument.includes("://") || argument.includes("@") ? "<remote>" : argument,
          ),
          `${fetchOptions.fallbackErrorMessage}: ${networkFailureDetail(fetched.stderr)} (exit ${fetched.code})`,
        );
      }

      const commit = yield* runGitStdout("GitCore.fetchRemoteBranchCommit.resolve", input.cwd, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${fullRefName}^{commit}`,
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (!/^[0-9a-f]{40,64}$/iu.test(commit)) {
        return yield* createGitCommandError(
          "GitCore.fetchRemoteBranchCommit.resolve",
          input.cwd,
          ["rev-parse", "--verify", "--end-of-options", `${fullRefName}^{commit}`],
          `Fetched remote branch '${remoteName}/${branch}' did not resolve to a commit.`,
        );
      }

      return {
        remoteName,
        branch,
        refName: `${remoteName}/${branch}`,
        commit,
      };
    });

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = (input) =>
    Effect.gen(function* () {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      if (input.preserveExisting)
        return yield* fetchRemoteBranch({
          cwd: input.cwd,
          remoteName,
          remoteBranch: input.branch,
          remoteRef: `refs/pull/${input.prNumber}/head`,
          localBranch: input.branch,
          preserveExisting: true,
        });
      yield* executeGit(
        "GitCore.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorMessage: "git fetch pull request branch failed",
        },
      );
    }).pipe(Effect.asVoid);

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = (input) =>
    Effect.gen(function* () {
      yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        input.remoteName,
        `${input.preserveExisting ? "" : "+"}${input.remoteRef ?? `refs/heads/${input.remoteBranch}`}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      yield* runGit(
        "GitCore.fetchRemoteBranch.materialize",
        input.cwd,
        localBranchAlreadyExists && !input.preserveExisting
          ? ["branch", "--force", "--", input.localBranch, targetRef]
          : ["branch", "--", input.localBranch, targetRef],
      );
    }).pipe(Effect.asVoid);

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runGit("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      "--",
      input.branch,
    ]);

  const clearMissingRegistrationUnlocked = (cwd: string, path: string) =>
    Effect.gen(function* () {
      if (yield* checkoutExists(path))
        return yield* createGitCommandError(
          "GitCore.clearMissingRegistration",
          cwd,
          [],
          "The checkout still exists.",
        );
      const target = yield* canonicalPath(path);
      const entry = (yield* listWorktrees(cwd)).find((entry) => entry.canonicalPath === target);
      if (!entry) return;
      if (entry.isMain || entry.locked !== null)
        return yield* createGitCommandError(
          "GitCore.clearMissingRegistration",
          cwd,
          [],
          "The registration is primary or locked.",
        );
      if (yield* checkoutExists(entry.path))
        return yield* createGitCommandError(
          "GitCore.clearMissingRegistration",
          cwd,
          [],
          "The checkout appeared during inspection.",
        );
      yield* executeGit("GitCore.clearMissingRegistration", cwd, [
        "worktree",
        "remove",
        "--force",
        "--",
        entry.path,
      ]);
    });
  const clearMissingRegistration: GitCoreShape["clearMissingRegistration"] = (cwd, path) =>
    withWorktreeLifecycleLock(
      path,
      withRepositoryLock(
        "GitCore.clearMissingRegistration",
        cwd,
        clearMissingRegistrationUnlocked(cwd, path),
      ),
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(GitCommandError)(error)
          ? error
          : createGitCommandError("GitCore.clearMissingRegistration", cwd, [], error.message),
      ),
    );

  const removeWorktreeUnlocked = (input: Parameters<GitCoreShape["removeWorktree"]>[0]) =>
    Effect.gen(function* () {
      const target = yield* canonicalPath(resolvePath(input.cwd, input.path));
      const entry = (yield* listWorktrees(input.cwd)).find(
        (entry) => entry.canonicalPath === target,
      );
      const finishRemoval = Effect.gen(function* () {
        const receipt = yield* preparations.latest(target);
        if (receipt && receipt.phase !== "skipped")
          yield* preparations.update(receipt, {
            phase: "skipped",
            error: "Checkout was safely removed.",
          });
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError("GitCore.removeWorktree", input.cwd, [], error.message),
        ),
      );
      if (!(yield* checkoutExists(target))) {
        yield* clearMissingRegistrationUnlocked(input.cwd, target);
        return yield* finishRemoval;
      }
      if (!entry || entry.isMain || entry.locked !== null)
        return yield* createGitCommandError(
          "GitCore.removeWorktree",
          input.cwd,
          ["worktree", "remove", "--", input.path],
          `The target ${input.path} is not an unlocked linked worktree.`,
        );
      const inspection = yield* inspectCheckout(
        target,
        input.discardChanges ? { changesFingerprint: true } : undefined,
      );
      if (inspection.hasInitializedSubmodules)
        return yield* createGitCommandError(
          "GitCore.removeWorktree",
          input.cwd,
          [],
          "Initialized submodules prevent safe removal. Deinitialize them after preserving their local work, then retry.",
        );
      const expectedCommon = yield* resolveCommonDir(input.cwd).pipe(Effect.flatMap(canonicalPath));
      const hasChanges = inspection.hasTrackedChanges || inspection.hasUntrackedChanges;
      // Discarding is allowed only for the exact reviewed change set, unchanged since review.
      const discardsReviewedChanges =
        hasChanges &&
        input.discardChanges !== undefined &&
        inspection.changesFingerprint === input.discardChanges.fingerprint &&
        sameStringSet(inspection.changedPaths ?? [], input.discardChanges.paths);
      if (
        inspection.commonDir !== expectedCommon ||
        inspection.canonicalRoot !== target ||
        inspection.registration?.canonicalPath !== target ||
        (inspection.branch === null && input.allowDetachedHead !== true) ||
        inspection.operation !== null ||
        (hasChanges && !discardsReviewedChanges) ||
        inspection.ignoredTruncated ||
        blockingIgnoredEntries(inspection.ignoredEntries, input.ignoredFiles).length > 0
      ) {
        return yield* createGitCommandError(
          "GitCore.removeWorktree",
          input.cwd,
          ["worktree", "remove", "--", input.path],
          "Checkout identity, local changes, or protected ignored files prevent removal.",
        );
      }
      if (discardsReviewedChanges) {
        // Discard exactly the reviewed paths instead of forcing removal: a file
        // an editor or watcher writes after the review stays a local change, and
        // the plain `worktree remove` below then refuses.
        const untracked = new Set(inspection.untrackedPaths ?? []);
        const tracked = (inspection.changedPaths ?? []).filter((path) => !untracked.has(path));
        if (tracked.length > 0)
          yield* executeGit(
            "GitCore.removeWorktree.restore",
            target,
            [
              "--literal-pathspecs",
              "restore",
              "--source=HEAD",
              "--staged",
              "--worktree",
              "--",
              ...tracked,
            ],
            { timeoutMs: 60_000 },
          );
        if (untracked.size > 0)
          yield* executeGit(
            "GitCore.removeWorktree.clean",
            target,
            ["--literal-pathspecs", "clean", "-f", "-q", "--", ...untracked],
            { timeoutMs: 60_000 },
          );
      }
      yield* executeGit(
        "GitCore.removeWorktree",
        input.cwd,
        [
          ...gitConfigArgs([["status.showUntrackedFiles", "all"]]),
          "worktree",
          "remove",
          "--",
          entry.path,
        ],
        {
          timeoutMs: 300_000,
          ...(discardsReviewedChanges
            ? {
                fallbackErrorMessage:
                  "The reviewed changes were discarded, but new local changes appeared, so the worktree was kept.",
              }
            : {}),
        },
      );
      yield* finishRemoval;
    });

  const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
    withWorktreeLifecycleLock(
      resolvePath(input.cwd, input.path),
      withRepositoryLock("GitCore.removeWorktree", input.cwd, removeWorktreeUnlocked(input)),
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(GitCommandError)(error)
          ? error
          : createGitCommandError("GitCore.removeWorktree", input.cwd, [], error.message),
      ),
    );

  const renameBranch: GitCoreShape["renameBranch"] = (input) =>
    Effect.gen(function* () {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitCore.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    });

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    executeGit("GitCore.createBranch", input.cwd, ["branch", "--", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    }).pipe(Effect.asVoid);

  const resolveCheckoutTarget: GitCoreShape["resolveCheckoutTarget"] = (input) =>
    Effect.gen(function* () {
      // Checkout separates paths with --, so putting it before a branch would
      // change this into a file checkout. Reject option-shaped branch names.
      if (isUnsafeRefArgument(input.branch))
        return yield* createGitCommandError(
          "GitCore.checkoutBranch",
          input.cwd,
          [],
          "Invalid branch name.",
        );
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      const branch = localInputExists
        ? input.branch
        : remoteExists && localTrackingBranch
          ? localTrackingBranch
          : remoteExists && !localTrackedBranchTargetExists
            ? localTrackedBranchCandidate
            : null;
      const ref = localInputExists
        ? `refs/heads/${input.branch}`
        : remoteExists && localTrackingBranch
          ? `refs/heads/${localTrackingBranch}`
          : `refs/remotes/${input.branch}`;
      return { branch, headSha: yield* resolveCommit(input.cwd, ref), checkoutArgs };
    });
  const checkoutBranch: GitCoreShape["checkoutBranch"] = (input, options) =>
    Effect.gen(function* () {
      const target = yield* resolveCheckoutTarget(input);
      if (
        options?.expectedTarget &&
        (target.branch !== options.expectedTarget.branch ||
          target.headSha !== options.expectedTarget.headSha)
      )
        return yield* createGitCommandError(
          "GitCore.checkoutBranch",
          input.cwd,
          [],
          "The target branch changed after workspace verification.",
        );
      const checkoutArgs = target.checkoutArgs;
      yield* executeGit(
        "GitCore.checkoutBranch.checkout",
        input.cwd,
        [checkoutArgs[0]!, "--no-overwrite-ignore", ...checkoutArgs.slice(1), "--"],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git checkout failed",
          // Keep diagnostics stable for classification, regardless of the host's locale.
          env: { LC_ALL: "C" },
        },
      ).pipe(
        Effect.mapError((error) => {
          const files = checkoutConflictFiles(error.detail);
          return files === null
            ? error
            : new GitCommandError({
                ...error,
                checkoutConflict: { cwd: input.cwd, branch: input.branch, files },
              });
        }),
      );

      // Refresh upstream refs in the background so checkout remains responsive.
      if (options?.refreshUpstream !== false)
        yield* launchUpstreamRefresh(input.cwd, refreshCheckedOutBranchUpstream(input.cwd));
    });

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const listRemotes: GitCoreShape["listRemotes"] = (cwd) =>
    runGitStdout("GitCore.listRemotes", cwd, ["remote", "-v"]).pipe(
      Effect.map((stdout) =>
        [...parseRemoteFetchUrls(stdout)].map(([name, url]) => ({ name, url })),
      ),
    );

  return {
    ...makeMoveSnapshotOperations((cwd, args) => runGitStdout("GitCore.move", cwd, args)),
    status,
    ensureWorktree,
    readWorktreePreparation: (path) =>
      canonicalPath(path).pipe(
        Effect.flatMap(preparations.latest),
        Effect.mapError((error) =>
          createGitCommandError("GitCore.readWorktreePreparation", path, [], error.message),
        ),
      ),
    allocateWorktreePath,
    isValidBranchName,
    resolveAvailableBranchName,
    fastForwardTo: (cwd, sha) =>
      withRepositoryLock(
        "GitCore.fastForwardTo",
        cwd,
        runGit("GitCore.fastForwardTo", cwd, ["merge", "--ff-only", "--", sha]),
      ),
    initializeWorktreeSubmodules: (path, policy) => initializeSubmodules(path, policy),
    listWorktrees,
    isDirty,
    inspectCheckout,
    inspectCheckoutIdentity,
    clearMissingRegistration,
    branchExists,
    statusDetails,
    cleanupSafetyProbe,
    prepareCommitContext,
    commitPrepared,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    listRemotes,
    listBranches,
    createWorktree,
    hasRemote,
    fetchRemoteBranchCommit,
    fetchPullRequestBranch,
    ensureRemote,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
    resolveCommonDir,
    pruneWorktrees,
    resolveCommit,
    readOperationInProgress,
    isAncestor,
    deleteBranchIfAt,
    readFileAtRevision,
    listIgnoredEntries,
    renameBranch,
    createBranch,
    checkoutBranch,
    resolveCheckoutTarget,
    cloneRepository: (input) =>
      git
        .execute({
          operation: "GitCore.cloneRepository",
          cwd: input.cwd,
          args: ["clone", "--progress", "--", input.url, "."],
          timeoutMs: 15 * 60_000,
          maxOutputBytes: 1024 * 1024,
          env: { GIT_PROGRESS_DELAY: "0", LC_ALL: "C" },
          onStderrChunk: input.onProgress,
        })
        .pipe(Effect.asVoid),
    initRepo,
    listLocalBranchNames,
    readDefaultBranch: (cwd) => resolveDefaultBranchName(cwd, "origin"),
    drainUpstreamRefreshes: (cwd) =>
      Effect.suspend(() =>
        Effect.forEach([...(upstreamRefreshJobs.get(cwd) ?? [])], Fiber.await, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    subscribeStatusRefresh: (listener) =>
      Effect.sync(() => {
        statusRefreshListeners.add(listener);
        return () => {
          statusRefreshListeners.delete(listener);
        };
      }),
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore);
