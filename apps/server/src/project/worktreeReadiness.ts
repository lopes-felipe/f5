import { stat } from "node:fs/promises";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { Effect } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath, isTemporaryWorktreeBranch } from "../git/worktreePaths.ts";

export class WorktreeNotReadyError extends Error {
  readonly _tag = "WorktreeNotReadyError";
}
export class WorktreeInspectionError extends Error {
  readonly _tag = "WorktreeInspectionError";
}

/**
 * Whether the end-of-turn checkpoint sync re-records `branch` for this thread:
 * temporary branches are renamed later, and a path shared with another
 * conversation is not owned by this one.
 */
export const followsCheckoutBranchAtTurnEnd = (
  model: {
    readonly threads: ReadonlyArray<{
      readonly id: string;
      readonly projectId: string;
      readonly worktreePath: string | null;
      readonly scratchPath?: string | null | undefined;
      readonly deletedAt: string | null;
    }>;
    readonly projects: ReadonlyArray<{
      readonly id: string;
      readonly kind?: string | undefined;
      readonly workspaceRoot: string;
    }>;
  },
  threadId: string,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    if (isTemporaryWorktreeBranch(branch)) return false;
    const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(cwd));
    for (const other of model.threads) {
      if (other.id === threadId || other.deletedAt !== null) continue;
      const owner = model.projects.find((project) => project.id === other.projectId);
      const effective = threadWorkspaceCwd(other, owner);
      if (!effective) return false;
      if ((yield* Effect.tryPromise(() => canonicalWorktreePath(effective))) === canonical)
        return false;
    }
    return true;
  });

export const MISSING_WORKTREE_MESSAGE =
  "This thread's worktree is gone. Recreate it or continue in the project checkout.";

/** Read-only readiness shared by admission, recovery, startup and final delivery. */
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
    const canonical = yield* Effect.tryPromise(() => canonicalWorktreePath(target));
    const directoryExists = yield* Effect.tryPromise(() => stat(target)).pipe(
      Effect.map((entry) => entry.isDirectory()),
      Effect.catch((error) =>
        (error.cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
    const entries = yield* git.listWorktrees(input.projectCwd);
    const entry = entries.find((entry) => entry.canonicalPath === canonical);
    const branchExists =
      input.branch !== null && (yield* git.branchExists(input.projectCwd, input.branch));
    const defaultBranch = includeDefaultBranch
      ? ((yield* git.readDefaultBranch(input.projectCwd)) ??
        (yield* git.inspectCheckoutIdentity(input.projectCwd)).branch ??
        null)
      : null;
    let matching = entry !== undefined && (input.branch === null || entry.branch === input.branch);
    let checkoutBranch: string | null = null;
    let branchDriftOnly = false;
    if (directoryExists && input.worktreePath !== null) {
      const inspected = yield* git.inspectCheckoutIdentity(target);
      const expectedCommon = yield* git
        .resolveCommonDir(input.projectCwd)
        .pipe(Effect.flatMap((value) => Effect.tryPromise(() => canonicalWorktreePath(value))));
      const sameCheckout =
        entry !== undefined &&
        inspected.canonicalRoot === canonical &&
        inspected.commonDir === expectedCommon;
      checkoutBranch = inspected.branch;
      // The same registered checkout of this repository, only switched to
      // another branch (or detached), e.g. by an agent running `git checkout`.
      branchDriftOnly = sameCheckout && input.branch !== null && inspected.branch !== input.branch;
      matching =
        matching && sameCheckout && (input.branch === null || inspected.branch === input.branch);
    }
    const registration = entry
      ? matching
        ? directoryExists
          ? "matching"
          : "stale"
        : "otherBranch"
      : "none";
    return {
      worktreePath: input.worktreePath,
      branch: input.branch,
      directoryExists,
      registration,
      branchExists,
      defaultBranch,
      checkoutBranch,
      branchDriftOnly,
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
  options: {
    /**
     * Steers join a live turn whose cwd is already fixed, so a checkout that
     * only switched branches is still the workspace that turn is running in.
     */
    readonly allowBranchDrift?: boolean;
  } = {},
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
    if (!state.directoryExists && input.branch === null)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
    if (!state.directoryExists && !state.branchExists)
      return yield* Effect.fail(
        new WorktreeNotReadyError(
          `Worktree branch ${input.branch ?? "(unknown)"} is missing. ${MISSING_WORKTREE_MESSAGE}`,
        ),
      );
    if (options.allowBranchDrift && state.branchDriftOnly) return { branchDrift: true } as const;
    if (
      state.registration === "otherBranch" ||
      (state.directoryExists && state.registration !== "matching")
    )
      return yield* Effect.fail(
        new WorktreeNotReadyError(
          "The recorded worktree does not match this repository and branch. Recover the workspace before sending.",
        ),
      );
    if (!state.directoryExists && !allowRecreation)
      return yield* Effect.fail(new WorktreeNotReadyError(MISSING_WORKTREE_MESSAGE));
  });
