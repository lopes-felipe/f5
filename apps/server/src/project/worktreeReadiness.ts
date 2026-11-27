import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";

export class WorktreeNotReadyError extends Error {
  readonly _tag = "WorktreeNotReadyError";
}
export class WorktreeInspectionError extends Error {
  readonly _tag = "WorktreeInspectionError";
}

export const MISSING_WORKTREE_MESSAGE =
  "This thread's worktree is gone. Recreate it or continue in the project checkout.";

/**
 * Read-only readiness shared by admission, recovery, startup and final delivery.
 *
 * The folder is the thread's identity. A registered checkout of this
 * repository at the recorded path is `matching` whatever HEAD is on: the
 * recorded branch is only the last branch F5 observed there, and it is what a
 * missing folder is recreated from.
 */
export const readWorktreeState = (
  git: GitCoreShape,
  input: {
    projectCwd: string;
    worktreePath: string | null;
    branch: string | null;
  },
  includeDefaultBranch = true,
) =>
  Effect.gen(function* () {
    const target = input.worktreePath ?? input.projectCwd;
    const isDirectory = Effect.tryPromise(() => stat(target)).pipe(
      Effect.map((entry) => entry.isDirectory()),
      Effect.catch((error) =>
        (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    if (input.worktreePath && git.inspectWorktreeGroup) {
      const group = yield* git.inspectWorktreeGroup({
        projectRoot: input.projectCwd,
        path: input.worktreePath,
        branch: input.branch,
        // As below: the root checkout is this group's whatever HEAD is on.
        anyHead: true,
      });
      if (group)
        return {
          worktreePath: input.worktreePath,
          branch: input.branch,
          directoryExists: group.ready,
          // A group that cannot be recovered is foreign only while a folder is
          // in the way. A removed group whose branch is gone too is missing.
          registration: group.ready
            ? "matching"
            : group.recoverable
              ? "stale"
              : (yield* isDirectory)
                ? "foreign"
                : "none",
          branchExists: group.recoverable,
          defaultBranch: null,
          // Readiness no longer says which branch a group's root is on.
          headBranch: null,
        } as const;
    }
    const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(target));
    const directoryExists = yield* isDirectory;
    const entries = yield* git.listWorktrees(input.projectCwd);
    const entry = entries.find((entry) => entry.canonicalPath === canonical);
    const branchExists =
      input.branch !== null && (yield* git.branchExists(input.projectCwd, input.branch));
    const defaultBranch = includeDefaultBranch
      ? ((yield* git.readDefaultBranch(input.projectCwd)) ??
        (yield* git.inspectCheckoutIdentity(input.projectCwd)).branch ??
        null)
      : null;
    let matching = entry !== undefined;
    /** The branch HEAD is on now; null when detached, missing or foreign. */
    let headBranch: string | null = null;
    // An unregistered folder is foreign without asking Git, which may not even
    // find a repository there.
    if (directoryExists && input.worktreePath !== null && entry !== undefined) {
      const inspected = yield* git.inspectCheckoutIdentity(target);
      const expectedCommon = yield* git
        .resolveCommonDir(input.projectCwd)
        .pipe(Effect.flatMap((value) => Effect.tryPromise(() => canonicalWorktreePath(value))));
      matching = inspected.canonicalRoot === canonical && inspected.commonDir === expectedCommon;
      if (matching) headBranch = inspected.branch;
    }
    const registration = directoryExists
      ? matching
        ? "matching"
        : "foreign"
      : entry
        ? "stale"
        : "none";
    return {
      worktreePath: input.worktreePath,
      branch: input.branch,
      directoryExists,
      registration,
      branchExists,
      defaultBranch,
      headBranch,
    } as const;
  });

export const assertWorktreeReady = (
  git: GitCoreShape,
  input: {
    projectCwd: string;
    worktreePath: string | null;
    branch: string | null;
  },
  allowRecreation = false,
) =>
  Effect.gen(function* () {
    if (input.worktreePath === null) return;
    const state = yield* readWorktreeState(git, input, false).pipe(
      Effect.mapError(
        (error) =>
          new WorktreeInspectionError(
            `Workspace verification failed; retry the request. ${error.message}`,
            { cause: error },
          ),
      ),
    );
    if (state.registration === "matching") return;
    if (state.registration === "foreign")
      return yield* Effect.fail(
        new WorktreeNotReadyError(
          "The recorded worktree folder does not belong to this repository. Recover the workspace before sending.",
        ),
      );
    if (input.branch === null)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
    if (!state.branchExists)
      return yield* Effect.fail(
        new WorktreeNotReadyError(
          `Worktree branch ${input.branch} is missing. ${MISSING_WORKTREE_MESSAGE}`,
        ),
      );
    if (!allowRecreation)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
  });
