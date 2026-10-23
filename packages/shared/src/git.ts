/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a generated branch name, preserving any slash-separated namespace.
 * Unprefixed fragments use the `feature/` namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  // A generated name keeps its own namespace (`fix/…`, `team/jules/…`); only an
  // unprefixed fragment goes under `feature/`.
  return sanitized.includes("/") ? sanitized : `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = existingBranchNames.map((branch) => branch.toLowerCase());
  const existingRefs = new Set(existingNames);
  // Git cannot hold both `fix` and `fix/name`, so suffix the first path component a
  // ref blocks, or the final component when a ref already sits beneath it.
  let resolved = "";
  const parts = resolvedBase.split("/");
  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    let suffix = 2;
    while (
      existingRefs.has(candidate) ||
      (index === parts.length - 1 &&
        existingNames.some((branch) => branch.startsWith(`${candidate}/`)))
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }
  return resolved;
}

/** Treat filenames containing glob or pathspec magic as literal filenames. */
export const literalGitPathspec = (path: string): string => `:(literal)${path}`;

const GIT_CONFIG_OVERRIDE_KEYS = new Set([
  "core.splitindex",
  "splitindex.sharedindexexpire",
  "core.fsync",
  "core.fsyncmethod",
  "core.fsmonitor",
  "index.sparse",
  "sparse.expectfilesoutsideofpatterns",
  "protocol.file.allow",
  "status.showuntrackedfiles",
]);

/** Only app-owned configuration overrides may be placed in Git's argument vector. */
export function gitConfigArgs(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.flatMap(([key, value]) => {
    if (!GIT_CONFIG_OVERRIDE_KEYS.has(key.toLowerCase()) || /[\0\r\n]/.test(value))
      throw new Error(`Unsupported Git configuration override: ${key}`);
    return ["-c", `${key}=${value}`];
  });
}
