import { Effect } from "effect";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

export interface DefaultBranchContainment {
  readonly defaultBranch: string | null;
  /** True when HEAD is reachable from the default branch; null when it could not be checked. */
  readonly merged: boolean | null;
}

const resolveDefaultBranchCommit = (
  git: Pick<GitCoreShape, "resolveCommit">,
  projectRoot: string,
  defaultBranch: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    return (
      (yield* git
        .resolveCommit(projectRoot, `refs/remotes/origin/${defaultBranch}`)
        .pipe(Effect.orElseSucceed(() => null))) ??
      (yield* git
        .resolveCommit(projectRoot, `refs/heads/${defaultBranch}`)
        .pipe(Effect.orElseSucceed(() => null)))
    );
  });

/**
 * Whether `headSha` is already in the project's default branch. Prefers the
 * `origin/<default>` tracking ref, so a stale local default branch does not
 * hide merged work, and falls back to the local branch without a remote.
 */
export const resolveHeadInDefaultBranch = (
  git: Pick<GitCoreShape, "readAdvertisedDefaultBranch" | "resolveCommit" | "isAncestor">,
  projectRoot: string,
  headSha: string,
): Effect.Effect<DefaultBranchContainment> =>
  Effect.gen(function* () {
    const defaultBranch = yield* git.readAdvertisedDefaultBranch(projectRoot);
    if (defaultBranch === null) return { defaultBranch, merged: null };
    const defaultSha = yield* resolveDefaultBranchCommit(git, projectRoot, defaultBranch);
    if (defaultSha === null) return { defaultBranch, merged: null };
    const merged = yield* git
      .isAncestor(projectRoot, headSha, defaultSha)
      .pipe(Effect.orElseSucceed(() => null));
    return { defaultBranch, merged };
  });

/**
 * Fetch `origin/<default>` when neither it nor a local default branch exists,
 * as when the default is known only from the remote's advertised HEAD. Merge
 * checks otherwise have nothing to compare against. Once fetched, the
 * tracking ref exists and later calls do not touch the network.
 */
export const fetchMissingDefaultBranch = (
  git: Pick<
    GitCoreShape,
    "readAdvertisedDefaultBranch" | "resolveCommit" | "fetchRemoteBranchCommit"
  >,
  projectRoot: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const defaultBranch = yield* git.readAdvertisedDefaultBranch(projectRoot);
    if (defaultBranch === null) return;
    if ((yield* resolveDefaultBranchCommit(git, projectRoot, defaultBranch)) !== null) return;
    yield* git
      .fetchRemoteBranchCommit({ cwd: projectRoot, branch: defaultBranch, remoteName: "origin" })
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause(() => Effect.void),
      );
  });

/**
 * Refresh `origin/<default>` without touching local branches. Returns a
 * warning message on failure; merge checks then use the last fetched refs.
 */
export const refreshDefaultBranch = (
  git: Pick<GitCoreShape, "readAdvertisedDefaultBranch" | "fetchRemoteBranchCommit">,
  projectRoot: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const defaultBranch = yield* git.readAdvertisedDefaultBranch(projectRoot);
    if (defaultBranch === null) return null;
    return yield* git
      .fetchRemoteBranchCommit({ cwd: projectRoot, branch: defaultBranch, remoteName: "origin" })
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.as(null),
        Effect.catchCause(() =>
          Effect.succeed(
            `Could not refresh origin/${defaultBranch}; merge checks use refs from the last fetch.`,
          ),
        ),
      );
  });
