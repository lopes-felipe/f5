import {
  buildPlaceholderBranchName,
  flattenLegacyPlaceholderBranchName,
  isLegacyPlaceholderBranch,
  isPlaceholderBranch,
  LEGACY_BRANCH_PREFIX,
} from "@t3tools/shared/branchNaming";
import { Effect } from "effect";

import type { GitCoreShape } from "./Services/GitCore.ts";

/**
 * Legacy `t3code/<hex>` placeholders cannot be created while a plain `t3code` ref
 * occupies their directory; they fall back to `t3code-<hex>`. Current placeholders
 * pass through unchanged.
 */
export const resolveLegacyPlaceholderBranch = (
  git: Pick<GitCoreShape, "branchExists">,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    if (
      branch.includes("/") &&
      isLegacyPlaceholderBranch(branch) &&
      (yield* git.branchExists(cwd, LEGACY_BRANCH_PREFIX))
    )
      return flattenLegacyPlaceholderBranchName(branch);
    return branch;
  });

/**
 * The name a new placeholder branch is created under. Placeholders come from the
 * first message, so two threads can ask for the same one: take the next free
 * `-1`, `-2`… name, including names other preparations have reserved.
 */
export const resolvePlaceholderBranch = (
  git: Pick<GitCoreShape, "branchExists" | "resolveAvailableBranchName">,
  cwd: string,
  branch: string,
) =>
  Effect.gen(function* () {
    if (isLegacyPlaceholderBranch(branch))
      return yield* resolveLegacyPlaceholderBranch(git, cwd, branch);
    if (!isPlaceholderBranch(branch)) return branch;
    return yield* git.resolveAvailableBranchName(cwd, branch);
  });

/**
 * A request's branch, or a placeholder from its source text when naming is automatic.
 * Older clients send a `t3code/<hex>` placeholder; that also means "automatic".
 */
export function placeholderBranchFor(input: {
  readonly requested: string | null | undefined;
  readonly prefix: string;
  readonly sourceText: string | null | undefined;
}): string {
  return input.requested && !isLegacyPlaceholderBranch(input.requested)
    ? input.requested
    : buildPlaceholderBranchName({ prefix: input.prefix, sourceText: input.sourceText });
}
