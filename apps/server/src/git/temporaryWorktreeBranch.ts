import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  TEMPORARY_WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/worktree";
import { Effect } from "effect";
import type { GitCoreShape } from "./Services/GitCore.ts";

export const resolveTemporaryWorktreeBranch = (
  git: Pick<GitCoreShape, "branchExists">,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    if (
      branch.includes("/") &&
      isTemporaryWorktreeBranch(branch) &&
      (yield* git.branchExists(cwd, TEMPORARY_WORKTREE_BRANCH_PREFIX))
    )
      return flattenTemporaryWorktreeBranchName(branch);
    return branch;
  });
