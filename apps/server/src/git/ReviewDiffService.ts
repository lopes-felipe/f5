import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  OrchestrationReadModel,
  ReviewPreviewDiffErrorCode,
  ReviewPreviewDiffFailure,
  ReviewPreviewDiffInput,
  ReviewPreviewDiffResult,
  ReviewPreviewDiffSuccess,
} from "@t3tools/contracts";
import { Data, Effect } from "effect";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import { REVIEW_PATCH_LIMIT_BYTES, truncatePatchAtFileBoundary } from "./patchTruncation.ts";

const STDERR_LIMIT_BYTES = 32 * 1024;
const UNTRACKED_LIMIT_PATHS = 512;
const UNTRACKED_LIMIT_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export interface ReviewDiffExecutionOptions {
  readonly commandTimeoutMs?: number;
  readonly processRunner?: typeof runProcess;
}

class ReviewDiffExecutionError extends Data.TaggedError("ReviewDiffExecutionError")<{
  readonly cause: unknown;
}> {}

const failure = (
  code: ReviewPreviewDiffErrorCode,
  message: string,
  retryable = false,
): ReviewPreviewDiffFailure => ({ kind: "error", code, message, retryable });

interface WorkingTreePatch {
  readonly kind: "patch";
  readonly patch: string;
  readonly truncated: boolean;
  readonly reason: string | null;
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { env?: NodeJS.ProcessEnv; stdoutLimit?: number },
  execution: ReviewDiffExecutionOptions = {},
): Effect.Effect<ProcessRunResult, Error> {
  return Effect.callback<ProcessRunResult, Error>((resume, signal) => {
    void (execution.processRunner ?? runProcess)("git", args, {
      cwd,
      timeoutMs: execution.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
      maxStdoutBytes: options?.stdoutLimit ?? REVIEW_PATCH_LIMIT_BYTES * 2,
      maxStderrBytes: STDERR_LIMIT_BYTES,
      signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        ...options?.env,
      },
    }).then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) =>
        resume(Effect.fail(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

function commandFailure(result: ProcessRunResult): ReviewPreviewDiffFailure | null {
  if (result.aborted) return failure("cancelled", "Diff generation was cancelled.", true);
  if (result.timedOut) return failure("timeout", "Git diff generation timed out.", true);
  if (result.code !== 0) {
    return failure("git_failed", result.stderr.trim() || "Git diff generation failed.", true);
  }
  return null;
}

async function canonicalRegisteredPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const registeredPathStat = await lstat(resolved);
  if (registeredPathStat.isSymbolicLink()) {
    throw new Error("Registered workspaces must not be symbolic links.");
  }
  return realpath(resolved);
}

function resolveThreadCwd(
  readModel: OrchestrationReadModel,
  input: ReviewPreviewDiffInput,
): Effect.Effect<string, ReviewPreviewDiffResult> {
  const thread = readModel.threads.find((candidate) => candidate.id === input.threadId);
  if (!thread) return Effect.fail(failure("thread_not_found", "Thread not found."));
  const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
  if (!project) return Effect.fail(failure("project_not_found", "Thread project not found."));

  const registeredPath = thread.worktreePath ?? project.workspaceRoot;
  return Effect.tryPromise({
    try: () => canonicalRegisteredPath(registeredPath),
    catch: () => failure("workspace_invalid", "Thread workspace could not be resolved."),
  });
}

function resolveCommit(cwd: string, ref: string, execution: ReviewDiffExecutionOptions) {
  return runGit(
    cwd,
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    undefined,
    execution,
  ).pipe(Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)));
}

function resolveDefaultBaseRef(cwd: string, execution: ReviewDiffExecutionOptions) {
  return Effect.gen(function* () {
    const remoteHead = yield* runGit(
      cwd,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      undefined,
      execution,
    );
    if (remoteHead.code === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim();

    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
      if ((yield* resolveCommit(cwd, candidate, execution)) !== null) return candidate;
    }

    const currentBranch = yield* runGit(
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      undefined,
      execution,
    );
    const upstream = yield* runGit(
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      undefined,
      execution,
    );
    const currentBranchName = currentBranch.code === 0 ? currentBranch.stdout.trim() : "";
    const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : "";
    if (
      upstreamName &&
      currentBranchName &&
      upstreamName !== currentBranchName &&
      !upstreamName.endsWith(`/${currentBranchName}`)
    ) {
      return upstreamName;
    }
    return null;
  });
}

function makeWorkingTreePatch(
  cwd: string,
  ignoreWhitespace: boolean,
  execution: ReviewDiffExecutionOptions,
): Effect.Effect<WorkingTreePatch | ReviewPreviewDiffFailure, Error> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await mkdir(tmpdir(), { recursive: true });
        return mkdtemp(path.join(tmpdir(), "f5-review-index-"));
      },
      catch: (cause) => new ReviewDiffExecutionError({ cause }),
    }),
    (directory) =>
      Effect.gen(function* () {
        const indexPath = path.join(directory, `index-${randomUUID()}`);
        const env = { GIT_INDEX_FILE: indexPath };
        const readTree = yield* runGit(cwd, ["read-tree", "HEAD"], { env }, execution);
        const readTreeFailure = commandFailure(readTree);
        if (readTreeFailure) return readTreeFailure;

        const untracked = yield* runGit(
          cwd,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          {
            stdoutLimit: UNTRACKED_LIMIT_BYTES,
          },
          execution,
        );
        const untrackedFailure = commandFailure(untracked);
        if (untrackedFailure) return untrackedFailure;
        const stagedAdditions = yield* runGit(
          cwd,
          [
            "diff",
            "--cached",
            "--no-renames",
            "--name-only",
            "--diff-filter=A",
            "-z",
            "HEAD",
            "--",
          ],
          { stdoutLimit: UNTRACKED_LIMIT_BYTES },
          execution,
        );
        const stagedAdditionsFailure = commandFailure(stagedAdditions);
        if (stagedAdditionsFailure) return stagedAdditionsFailure;
        const untrackedOutput = untracked.stdoutTruncated
          ? untracked.stdout.slice(0, untracked.stdout.lastIndexOf("\0") + 1)
          : untracked.stdout;
        const stagedAdditionsOutput = stagedAdditions.stdoutTruncated
          ? stagedAdditions.stdout.slice(0, stagedAdditions.stdout.lastIndexOf("\0") + 1)
          : stagedAdditions.stdout;
        const allPaths = untrackedOutput.split("\0").filter(Boolean);
        const untrackedTruncated =
          untracked.stdoutTruncated === true || allPaths.length > UNTRACKED_LIMIT_PATHS;
        const stagedAdditionPaths = stagedAdditionsOutput.split("\0").filter(Boolean);
        const stagedAdditionsTruncated = stagedAdditions.stdoutTruncated === true;
        const candidatePaths = [
          ...allPaths.slice(0, UNTRACKED_LIMIT_PATHS),
          ...stagedAdditionPaths,
        ];
        const paths = (yield* Effect.promise(() =>
          Promise.all(
            [...new Set(candidatePaths)].map(async (candidate) =>
              lstat(path.join(cwd, candidate)).then(
                () => candidate,
                () => null,
              ),
            ),
          ),
        )).filter((candidate): candidate is string => candidate !== null);
        for (let offset = 0; offset < paths.length; offset += 64) {
          const add = yield* runGit(
            cwd,
            ["add", "-N", "--", ...paths.slice(offset, offset + 64)],
            {
              env,
            },
            execution,
          );
          const addFailure = commandFailure(add);
          if (addFailure) return addFailure;
        }

        const diff = yield* runGit(
          cwd,
          [
            "diff",
            "--binary",
            "--full-index",
            "--minimal",
            "--find-renames",
            ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
            "HEAD",
            "--",
          ],
          { env },
          execution,
        );
        const diffFailure = commandFailure(diff);
        if (diffFailure) return diffFailure;
        const bounded = truncatePatchAtFileBoundary(diff.stdout, diff.stdoutTruncated === true);
        return {
          kind: "patch" as const,
          patch: bounded.patch,
          truncated: bounded.truncated || untrackedTruncated || stagedAdditionsTruncated,
          reason:
            (untrackedTruncated
              ? `Only the first ${UNTRACKED_LIMIT_PATHS} untracked paths were included.`
              : null) ??
            (stagedAdditionsTruncated ? "The staged additions list was truncated." : null) ??
            bounded.reason,
        };
      }),
    (directory) =>
      Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
  );
}

export function getReviewPreviewDiff(
  input: {
    readonly request: ReviewPreviewDiffInput;
    readonly readModel: OrchestrationReadModel;
  },
  execution: ReviewDiffExecutionOptions = {},
): Effect.Effect<ReviewPreviewDiffResult> {
  return Effect.gen(function* () {
    const cwdResult = yield* Effect.result(resolveThreadCwd(input.readModel, input.request));
    if (cwdResult._tag === "Failure") return cwdResult.failure;
    const cwd = cwdResult.success;

    const repositoryProbe = yield* runGit(
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      undefined,
      execution,
    );
    if (repositoryProbe.code !== 0 || repositoryProbe.stdout.trim() !== "true") {
      return failure("not_a_repository", "Thread workspace is not a Git repository.");
    }
    const headCommit = yield* resolveCommit(cwd, "HEAD", execution);
    if (!headCommit) return failure("unborn_head", "The repository has no HEAD commit.");

    if (input.request.scope === "working-tree") {
      const working = yield* makeWorkingTreePatch(
        cwd,
        input.request.ignoreWhitespace === true,
        execution,
      ).pipe(Effect.catch(() => Effect.succeed(failure("git_failed", "Git diff failed.", true))));
      if (working.kind === "error") return working;
      const success: ReviewPreviewDiffSuccess = {
        kind: "success",
        source: { kind: "working-tree" },
        baseRef: null,
        baseCommit: headCommit,
        headCommit,
        patch: working.patch,
        diffHash: createHash("sha256").update(working.patch).digest("hex"),
        truncated: working.truncated,
        truncationReason: working.reason,
      };
      return success;
    }

    const branch = yield* runGit(
      cwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      undefined,
      execution,
    );
    if (!input.request.baseRef && branch.code !== 0) {
      return failure("detached_head", "Choose a base ref while HEAD is detached.");
    }
    const baseRef = input.request.baseRef ?? (yield* resolveDefaultBaseRef(cwd, execution));
    if (!baseRef) return failure("missing_base", "No branch-range base ref could be resolved.");
    const baseCommit = yield* resolveCommit(cwd, baseRef, execution);
    if (!baseCommit)
      return failure("invalid_ref", `Base ref does not resolve to a commit: ${baseRef}`);

    const diff = yield* runGit(
      cwd,
      [
        "diff",
        "--binary",
        "--full-index",
        "--minimal",
        ...(input.request.ignoreWhitespace ? ["--ignore-all-space"] : []),
        `${baseCommit}...${headCommit}`,
        "--",
      ],
      undefined,
      execution,
    );
    const diffFailure = commandFailure(diff);
    if (diffFailure) return diffFailure;
    const bounded = truncatePatchAtFileBoundary(diff.stdout, diff.stdoutTruncated === true);
    const success: ReviewPreviewDiffSuccess = {
      kind: "success",
      source: { kind: "branch-range" },
      baseRef,
      baseCommit,
      headCommit,
      patch: bounded.patch,
      diffHash: createHash("sha256").update(bounded.patch).digest("hex"),
      truncated: bounded.truncated,
      truncationReason: bounded.reason,
    };
    return success;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        failure("git_failed", error instanceof Error ? error.message : String(error), true),
      ),
    ),
  );
}
