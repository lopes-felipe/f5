import { Effect } from "effect";
import type { GitCoreShape } from "./Services/GitCore.ts";
import { GitManagerError } from "./Errors.ts";
import type { SourceControlPullRequestSummary } from "../sourceControl/SourceControlProvider.ts";

type BranchReads = Pick<
  GitCoreShape,
  "isValidBranchName" | "listRemotes" | "readConfigValue" | "resolveCommit" | "readDefaultBranch"
>;
export interface BranchPullRequestContext {
  readonly branch: string;
  readonly upstreamRef: string | null;
  readonly remoteName?: string;
}
/** Read refs and config only. A lookup must never scan or refresh the working tree. */
export function lookupBranchPullRequest<E>(
  git: BranchReads,
  input: { cwd: string; branch: string },
  lookup: (
    context: BranchPullRequestContext,
  ) => Effect.Effect<SourceControlPullRequestSummary | null, E>,
) {
  const refused = (detail: string) =>
    new GitManagerError({ operation: "branchPullRequest", detail });
  return Effect.gen(function* () {
    if (!(yield* git.isValidBranchName(input.branch)))
      return yield* refused("The branch name is invalid.");
    const inspect = Effect.gen(function* () {
      const remotes = [...(yield* git.listRemotes(input.cwd))].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (remotes.length > 16)
        return yield* refused("There are too many remotes to verify this branch automatically.");
      const [savedRemote, savedMerge, localOid, defaultBranch] = yield* Effect.all(
        [
          git.readConfigValue(input.cwd, `branch.${input.branch}.remote`),
          git.readConfigValue(input.cwd, `branch.${input.branch}.merge`),
          git.resolveCommit(input.cwd, `refs/heads/${input.branch}`),
          git.readDefaultBranch(input.cwd),
        ],
        { concurrency: 4 },
      );
      if (
        (savedRemote === null) !== (savedMerge === null) ||
        savedRemote === "" ||
        savedRemote === "." ||
        (savedMerge !== null &&
          (!savedMerge.startsWith("refs/heads/") || savedMerge === "refs/heads/"))
      )
        return yield* refused(
          "The saved upstream is incomplete or does not identify a remote repository.",
        );
      if (savedRemote && !remotes.some((remote) => remote.name === savedRemote))
        return yield* refused("The saved upstream remote is missing.");
      let remoteName = savedRemote;
      let upstreamRef =
        savedRemote && savedMerge
          ? `${savedRemote}/${savedMerge.slice("refs/heads/".length)}`
          : null;
      let commitOid = localOid;
      if (!localOid && !savedRemote) {
        const matches = (yield* Effect.forEach(
          remotes,
          (remote) =>
            git
              .resolveCommit(input.cwd, `refs/remotes/${remote.name}/${input.branch}`)
              .pipe(Effect.map((oid) => ({ remote: remote.name, oid }))),
          { concurrency: 4 },
        )).filter((match) => match.oid !== null);
        if (matches.length > 1)
          return yield* refused(
            "Multiple remotes track this branch. Its pull request is ambiguous.",
          );
        if (matches[0]) {
          remoteName = matches[0].remote;
          commitOid = matches[0].oid;
          upstreamRef = `${remoteName}/${input.branch}`;
        }
      }
      if (!commitOid && remoteName && savedMerge)
        commitOid = yield* git.resolveCommit(
          input.cwd,
          `refs/remotes/${remoteName}/${savedMerge.slice("refs/heads/".length)}`,
        );
      return {
        remotes,
        savedRemote,
        savedMerge,
        localOid,
        commitOid,
        defaultBranch,
        remoteName,
        upstreamRef,
      };
    });
    const before = yield* inspect;
    if (!before.remotes.length) return null;
    const result = yield* lookup({
      branch: input.branch,
      upstreamRef: before.upstreamRef,
      ...(before.remoteName ? { remoteName: before.remoteName } : {}),
    });
    const after = yield* inspect;
    if (JSON.stringify(before) !== JSON.stringify(after))
      return yield* refused(
        "Repository or branch identity changed during the pull request lookup.",
      );
    if (!result || result.state === "open") return result;
    if (result.state !== "closed" && result.state !== "merged")
      return yield* refused("The pull request state is unknown.");
    // A closed PR for an old branch incarnation does not prove the current branch is done.
    if (
      input.branch === before.defaultBranch ||
      (before.defaultBranch === null && ["main", "master"].includes(input.branch))
    )
      return null;
    if (!before.commitOid || !result.headRefOid || result.headRefOid !== before.commitOid)
      return yield* refused("The terminal PR head does not prove this branch is complete.");
    return result;
  });
}
