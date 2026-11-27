import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath, isLeftoverWorktreeFolder } from "../git/worktreePaths.ts";

export class WorktreeNotReadyError extends Error {
  readonly _tag = "WorktreeNotReadyError";
}
export class WorktreeInspectionError extends Error {
  readonly _tag = "WorktreeInspectionError";
}

export const MISSING_WORKTREE_MESSAGE = "This thread's worktree is not on disk.";

/**
 * The remote-tracking copy of a branch, as `<remote>/<branch>`, or null when no
 * remote has it. `origin` is preferred. Nothing is fetched: it reads what the
 * repository already knows.
 */
export const findRemoteBranch = (
  git: Pick<GitCoreShape, "listRemotes" | "resolveCommit">,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    const remotes = (yield* git.listRemotes(cwd)).map((remote) => remote.name);
    const ordered = [
      ...remotes.filter((name) => name === "origin"),
      ...remotes.filter((name) => name !== "origin"),
    ];
    for (const remote of ordered)
      if (yield* git.resolveCommit(cwd, `refs/remotes/${remote}/${branch}`))
        return `${remote}/${branch}`;
    return null;
  });

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
          branchCheckedOutAt: null,
          remoteBranch: null,
          grouped: true,
        } as const;
    }
    const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(target));
    const directoryExists = yield* isDirectory;
    const entries = yield* git.listWorktrees(input.projectCwd);
    const entry = entries.find((entry) => entry.canonicalPath === canonical);
    const branchExists =
      input.branch !== null && (yield* git.branchExists(input.projectCwd, input.branch));
    // Only a branch that is gone is started again from the default branch.
    const defaultBranch =
      includeDefaultBranch && !branchExists
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
      // A registered folder Git cannot read is foreign too when it is no
      // checkout at all. Any other failure stays a failure.
      const inspected = yield* git
        .inspectCheckoutIdentity(target)
        .pipe(
          Effect.catch((error) =>
            Effect.tryPromise(() => isLeftoverWorktreeFolder(target)).pipe(
              Effect.flatMap((leftover) => (leftover ? Effect.succeed(null) : Effect.fail(error))),
            ),
          ),
        );
      const expectedCommon = yield* git
        .resolveCommonDir(input.projectCwd)
        .pipe(Effect.flatMap((value) => Effect.tryPromise(() => canonicalWorktreePath(value))));
      matching =
        inspected !== null &&
        inspected.canonicalRoot === canonical &&
        inspected.commonDir === expectedCommon;
      if (inspected !== null && matching) headBranch = inspected.branch;
    }
    // Another checkout on the recorded branch: Git refuses a second one, so a
    // missing worktree cannot come back on that branch while it stands. A
    // leftover folder holds nothing, and recreation takes the branch from it.
    // Every registration on the branch is looked at: a leftover one can be
    // listed in front of a live checkout.
    let holder: (typeof entries)[number] | undefined;
    for (const other of input.branch === null ? [] : entries) {
      if (other.canonicalPath === canonical || other.branch !== input.branch) continue;
      const leftover =
        !other.isMain &&
        other.locked === null &&
        (yield* Effect.tryPromise(() => isLeftoverWorktreeFolder(other.path)));
      if (leftover) continue;
      holder = other;
      break;
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
      branchCheckedOutAt: holder?.path ?? null,
      // Asked for with the default branch: both say where a branch that is
      // gone would be started again from.
      remoteBranch:
        includeDefaultBranch && input.branch !== null && !branchExists
          ? yield* findRemoteBranch(git, input.projectCwd, input.branch).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null,
      grouped: false,
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
          "The folder recorded for this thread's worktree now holds something else.",
        ),
      );
    if (input.branch === null)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
    if (!state.branchExists)
      return yield* Effect.fail(
        new WorktreeNotReadyError(
          `${MISSING_WORKTREE_MESSAGE} Its branch ${input.branch} no longer exists.`,
        ),
      );
    if (!allowRecreation)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
  });
