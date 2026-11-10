import { Effect } from "effect";
import type { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

/**
 * How the base commit for a new worktree was chosen:
 * - `remote`: the fetched remote branch, because the local branch is missing, equal or behind.
 * - `local-only`: the branch is not on the remote; the local branch is the only base.
 * - `local-ahead`: the local branch has commits the remote lacks; using the remote would drop them.
 * - `local-diverged`: local and remote both moved (or ancestry is unknown); the selected local branch wins.
 * - `no-remote`: the repository has no remote.
 * - `unreachable`: the remote could not be queried; the local branch may be stale.
 */
export type WorktreeBaseOutcome =
  | "remote"
  | "local-only"
  | "local-ahead"
  | "local-diverged"
  | "no-remote"
  | "unreachable";

export interface WorktreeBase {
  /** The fetched remote commit when the remote was chosen, otherwise the requested branch name. */
  readonly baseRef: string;
  /** Null when the chosen ref has no commit to start from. */
  readonly baseSha: string | null;
  readonly outcome: WorktreeBaseOutcome;
  /** Short human readable explanation of the choice, for the setup card. */
  readonly detail: string;
}

/**
 * Picks the commit a new worktree starts from. Refreshes `<remote>/<baseBranch>`
 * and uses it only when it contains the local branch, so a stale local `main`
 * picks up upstream work while unpushed local commits are never dropped. A
 * branch that only exists locally is a normal case, not a failure.
 */
export const resolveWorktreeBase = (
  git: Pick<GitCoreShape, "hasRemote" | "fetchRemoteBranchCommit" | "resolveCommit" | "isAncestor">,
  input: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly logAnnotations?: Record<string, unknown>;
  },
): Effect.Effect<WorktreeBase, GitCommandError> =>
  Effect.gen(function* () {
    const { projectCwd, baseBranch } = input;
    const local = (detail: string, outcome: WorktreeBaseOutcome) =>
      git.resolveCommit(projectCwd, baseBranch).pipe(
        Effect.map(
          (baseSha): WorktreeBase => ({
            baseRef: baseBranch,
            baseSha,
            outcome,
            detail,
          }),
        ),
      );

    const hasRemote = yield* git.hasRemote(projectCwd).pipe(Effect.orElseSucceed(() => false));
    if (!hasRemote) return yield* local("no remote", "no-remote");

    const fetched = yield* git
      .fetchRemoteBranchCommit({ cwd: projectCwd, branch: baseBranch, allowMissingBranch: true })
      .pipe(
        Effect.map((remote) => ({ ok: true as const, remote })),
        // The raw git error is internal and unreadable in the card; log it and
        // report what actually happened instead.
        Effect.catch((error) =>
          Effect.logWarning("worktree setup could not fetch the remote base branch", {
            ...input.logAnnotations,
            baseBranch,
            error: error.message,
          }).pipe(Effect.as({ ok: false as const, remote: null })),
        ),
      );
    if (!fetched.ok)
      return yield* local(`Couldn't reach the remote; using local ${baseBranch}`, "unreachable");
    const remote = fetched.remote;
    if (remote === null)
      return yield* local(`Using local ${baseBranch} (not on the remote)`, "local-only");

    const useRemote: WorktreeBase = {
      baseRef: remote.commit,
      baseSha: remote.commit,
      outcome: "remote",
      detail: `${remote.refName} at ${remote.commit.slice(0, 7)}`,
    };
    const localSha = yield* git.resolveCommit(projectCwd, baseBranch);
    if (localSha === null || localSha === remote.commit) return useRemote;

    const isAncestor = (ancestor: string, descendant: string) =>
      git.isAncestor(projectCwd, ancestor, descendant).pipe(Effect.orElseSucceed(() => null));
    if ((yield* isAncestor(localSha, remote.commit)) === true) return useRemote;
    const ahead = (yield* isAncestor(remote.commit, localSha)) === true;
    return {
      baseRef: baseBranch,
      baseSha: localSha,
      outcome: ahead ? "local-ahead" : "local-diverged",
      detail: ahead
        ? `Using local ${baseBranch} (ahead of ${remote.refName})`
        : `Using local ${baseBranch} (diverged from ${remote.refName})`,
    };
  });
