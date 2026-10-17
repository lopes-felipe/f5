import { stat } from "node:fs/promises";
import { Effect } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { canonicalWorktreePath } from "../git/worktreePaths.ts";

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
    const defaultBranch =
      (yield* git.readDefaultBranch(input.projectCwd)) ??
      (yield* git.inspectCheckout(input.projectCwd)).branch ??
      null;
    let matching = entry !== undefined && (input.branch === null || entry.branch === input.branch);
    if (directoryExists && input.worktreePath !== null) {
      const inspected = yield* git.inspectCheckout(target).pipe(Effect.orElseSucceed(() => null));
      const expectedCommon = yield* git
        .resolveCommonDir(input.projectCwd)
        .pipe(Effect.flatMap((value) => Effect.tryPromise(() => canonicalWorktreePath(value))));
      matching =
        matching &&
        inspected !== null &&
        inspected.canonicalRoot === canonical &&
        inspected.commonDir === expectedCommon &&
        (input.branch === null || inspected.branch === input.branch);
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
    const state = yield* readWorktreeState(git, input);
    if (!state.directoryExists && input.branch === null)
      return yield* Effect.fail(new Error(MISSING_WORKTREE_MESSAGE));
    if (!state.directoryExists && !state.branchExists)
      return yield* Effect.fail(
        new Error(
          `Worktree branch ${input.branch ?? "(unknown)"} is missing. ${MISSING_WORKTREE_MESSAGE}`,
        ),
      );
    if (
      state.registration === "otherBranch" ||
      (state.directoryExists && state.registration !== "matching")
    )
      return yield* Effect.fail(
        new Error(
          "The recorded worktree does not match this repository and branch. Recover the workspace before sending.",
        ),
      );
    if (!state.directoryExists && !allowRecreation)
      return yield* Effect.fail(new Error(MISSING_WORKTREE_MESSAGE));
  });
