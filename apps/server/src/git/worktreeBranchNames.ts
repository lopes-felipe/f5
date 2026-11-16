const WORKTREE_BRANCH_PREFIX = "t3code";

export function buildGeneratedWorktreeBranchName(raw: string, configuredPrefix: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  const prefix =
    configuredPrefix
      .trim()
      .toLowerCase()
      .replace(/^refs\/heads\//, "")
      .replace(/[^a-z0-9/_-]+/g, "-")
      .replace(/^\/+|\/+$/g, "") || "f5";
  return `${prefix}/${safeFragment}`;
}
