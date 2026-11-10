import { Effect } from "effect";
import type { GitCommandError } from "../git/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

/**
 * How the base commit for a new worktree was chosen:
 * - `remote`: the fetched remote branch, because the local branch is missing, equal or behind.
 * - `local-only`: the branch is not on the remote; the local branch is the only base.
 * - `local-ahead`: the local branch has commits the remote lacks; using the remote would drop them.
 * - `local-diverged`: local and remote both moved; the selected local branch wins, but it lacks
 *   upstream work, so callers should surface it.
 * - `ancestry-unknown`: local and remote differ and could not be compared; the local branch is used
 *   so no local commits are dropped, but it may be stale.
 * - `no-remote`: the repository has no remote.
 * - `unreachable`: the remote could not be queried; the local branch may be stale.
 */
export type WorktreeBaseOutcome =
  | "remote"
  | "local-only"
  | "local-ahead"
  | "local-diverged"
  | "ancestry-unknown"
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

/** Outcomes where the base may lack upstream work, worth a visible warning. */
export const isPossiblyStaleWorktreeBase = (outcome: WorktreeBaseOutcome): boolean =>
  outcome === "unreachable" || outcome === "local-diverged" || outcome === "ancestry-unknown";

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
    // Prefer the local branch: a bare name resolves a same-named tag first. Fall
    // back to the bare name for remote-qualified selections such as `origin/foo`.
    const resolveLocal = Effect.gen(function* () {
      const branchSha = yield* git.resolveCommit(projectCwd, `refs/heads/${baseBranch}`);
      return branchSha ?? (yield* git.resolveCommit(projectCwd, baseBranch));
    });
    const local = (detail: string, outcome: WorktreeBaseOutcome) =>
      resolveLocal.pipe(
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
    const localSha = yield* resolveLocal;
    if (localSha === null || localSha === remote.commit) return useRemote;

    const useLocal = (outcome: WorktreeBaseOutcome, detail: string): WorktreeBase => ({
      baseRef: baseBranch,
      baseSha: localSha,
      outcome,
      detail,
    });
    const compared = yield* Effect.all([
      git.isAncestor(projectCwd, localSha, remote.commit),
      git.isAncestor(projectCwd, remote.commit, localSha),
    ]).pipe(
      Effect.map(([behind, ahead]) => ({ ok: true as const, behind, ahead })),
      Effect.catch((error) =>
        Effect.logWarning("worktree setup could not compare the local and remote base", {
          ...input.logAnnotations,
          baseBranch,
          error: error.message,
        }).pipe(Effect.as({ ok: false as const, behind: false, ahead: false })),
      ),
    );
    if (!compared.ok)
      return useLocal(
        "ancestry-unknown",
        `Couldn't compare with ${remote.refName}; using local ${baseBranch}`,
      );
    if (compared.behind) return useRemote;
    if (compared.ahead)
      return useLocal("local-ahead", `Using local ${baseBranch} (ahead of ${remote.refName})`);
    return useLocal(
      "local-diverged",
      `Using local ${baseBranch} (diverged from ${remote.refName})`,
    );
  });
