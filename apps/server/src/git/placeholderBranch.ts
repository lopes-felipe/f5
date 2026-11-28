import {
  buildPlaceholderBranchName,
  flattenLegacyPlaceholderBranchName,
  isLegacyPlaceholderBranch,
  LEGACY_BRANCH_PREFIX,
} from "@t3tools/shared/branchNaming";
import { Effect } from "effect";

import { GitCommandError } from "./Errors.ts";
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
 * The name a new placeholder branch is created under, free in every repository
 * it will be created in. Placeholders come from the first message, so two threads
 * can ask for the same one: take the next free `-1`, `-2`… name, counting names
 * other preparations have reserved. A branch at an ancestor path (a plain `f5`
 * ref) blocks every name beneath it, so that fails with a pointer to the setting.
 *
 * Callers pass only names they built as placeholders; a legacy `t3code/<hex>` name
 * keeps its old flattening fallback.
 */
export const resolvePlaceholderBranchAcross = (
  git: Pick<GitCoreShape, "branchExists" | "resolveAvailableBranchName">,
  cwds: ReadonlyArray<string>,
  branch: string,
) =>
  Effect.gen(function* () {
    const [first] = cwds;
    if (first === undefined) return branch;
    if (isLegacyPlaceholderBranch(branch))
      return yield* resolveLegacyPlaceholderBranch(git, first, branch);
    const segments = branch.split("/");
    for (const cwd of cwds) {
      for (let depth = 1; depth < segments.length; depth += 1) {
        const ancestor = segments.slice(0, depth).join("/");
        if (yield* git.branchExists(cwd, ancestor))
          return yield* new GitCommandError({
            operation: "resolvePlaceholderBranch",
            command: "git branch",
            cwd,
            detail: `Branch '${ancestor}' blocks new branches named '${branch}'. Rename that branch, or change the Branch prefix in Settings > Git.`,
          });
      }
    }
    for (let suffix = 0; suffix <= 100; suffix += 1) {
      const candidate = suffix === 0 ? branch : `${branch}-${suffix}`;
      let free = true;
      for (const cwd of cwds) {
        if ((yield* git.resolveAvailableBranchName(cwd, candidate)) !== candidate) {
          free = false;
          break;
        }
      }
      if (free) return candidate;
    }
    return yield* new GitCommandError({
      operation: "resolvePlaceholderBranch",
      command: "git branch",
      cwd: first,
      detail: `Could not find an available branch name for '${branch}'.`,
    });
  });

export const resolvePlaceholderBranch = (
  git: Pick<GitCoreShape, "branchExists" | "resolveAvailableBranchName">,
  cwd: string,
  branch: string,
) => resolvePlaceholderBranchAcross(git, [cwd], branch);

/**
 * A request's branch, or a placeholder from its source text when naming is automatic.
 * Older clients send a `t3code/<hex>` placeholder; that also means "automatic".
 */
export function placeholderBranchFor(input: {
  readonly requested: string | null | undefined;
  readonly prefix: string;
  readonly sourceText: string | null | undefined;
}): { readonly branch: string; readonly automatic: boolean } {
  return input.requested && !isLegacyPlaceholderBranch(input.requested)
    ? { branch: input.requested, automatic: false }
    : {
        branch: buildPlaceholderBranchName({ prefix: input.prefix, sourceText: input.sourceText }),
        automatic: true,
      };
}
