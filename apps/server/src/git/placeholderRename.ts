import { ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * Renames an F5 placeholder branch to its final name before its first push. The
 * transport takes the worktree and repository lifecycle locks, re-checks that the
 * checkout is still on `oldBranch`, and records the new name on the preparation
 * receipt and the thread. Resolves to the branch now checked out, or null when
 * the placeholder was already renamed by someone else.
 */
export type GitPlaceholderRenameHandler = (input: {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}) => Effect.Effect<{ readonly branch: string } | null, Error>;

/** Transport-owned callback keeps Git workflows independent of orchestration services. */
export const GitPlaceholderRename = ServiceMap.Reference<null | GitPlaceholderRenameHandler>(
  "t3/git/GitPlaceholderRename",
  { defaultValue: () => null },
);
