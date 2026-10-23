import { Effect, Option } from "effect";
import { GitCommandError } from "../git/Errors.ts";
import type { PullRequestBranchDeletionResult } from "../git/githubBranchDeletion.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { resolveLocalCheckout } from "./localCheckout.ts";

/** Best-effort local cleanup after a confirmed remote result; never changes a checkout. */
export function cleanupLocalPrBranch(source: PullRequestBranchDeletionResult) {
  return Effect.gen(function* () {
    if (!source.absent)
      return "Remote branch deletion was not confirmed; local branches were kept.";
    const git = yield* Effect.serviceOption(GitCore);
    const projects = yield* Effect.serviceOption(ProjectionProjectRepository);
    if (Option.isNone(git) || Option.isNone(projects))
      return "Remote branch deleted; local branch cleanup is unavailable.";
    const entries = yield* projects.value.listAll();
    const [owner, repo] = source.repository.split("/");
    const candidates = yield* Effect.tryPromise({
      try: (signal) =>
        resolveLocalCheckout({
          provider: "github",
          host: source.host,
          repository: { owner: owner!, repo: repo!, nameWithOwner: source.repository },
          projects: entries
            .filter((project) => project.deletedAt === null)
            .map((project) => ({
              projectId: project.projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
            })),
          signal,
        }),
      catch: (cause) =>
        new GitCommandError({
          operation: "cleanupLocalPrBranch",
          command: "inspect registered repositories",
          cwd: "",
          detail: "Could not verify local repositories.",
          cause,
        }),
    });
    let kept = false;
    for (const candidate of candidates) {
      const branches = yield* git.value.listBranches({ cwd: candidate.cwd });
      const branch = branches.branches.find(
        (branch) => !branch.isRemote && branch.name === source.branch,
      );
      if (!branch) continue;
      if (
        !branches.isRepo ||
        branches.worktreeMissing ||
        branch.isDefault ||
        branch.current ||
        branch.worktreePath
      ) {
        kept = true;
        continue;
      }
      const removed = yield* git.value.deleteBranchIfAt({
        cwd: candidate.cwd,
        branch: source.branch,
        expectedSha: source.headOid,
        onlyIfUnused: true,
      });
      if (!removed) kept = true;
    }
    return kept
      ? "Remote branch deleted; local branches in use, protected or changed were kept."
      : undefined;
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catch(() =>
      Effect.succeed(
        "Remote branch deleted; local cleanup could not be confirmed. Local branches may remain.",
      ),
    ),
  );
}
