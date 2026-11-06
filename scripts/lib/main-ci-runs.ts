// scripts/lib is also part of the server project, so keep this file free of scripts/release imports.
export interface MainCiRunIdentity {
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  repository: { full_name: string };
  head_repository: { full_name: string } | null;
}

export interface CommitPage {
  files: { filename: string; previous_filename?: string }[];
  parents: { sha: string }[];
}

/** A main push run of `ci.yml` from this repository, never a fork or another workflow. */
export function trustedMainCiRun(run: MainCiRunIdentity, repository: string): boolean {
  return (
    run.path === ".github/workflows/ci.yml" &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository.full_name === repository &&
    run.head_repository?.full_name === repository &&
    /^[a-f0-9]{40}$/.test(run.head_sha)
  );
}

/**
 * Whether a commit may carry release intent, so queue automation must leave its CI to the
 * release publisher. Truncated diffs and true merges cannot prove that first-parent intent
 * changes are absent, so they count as protected rather than inferring eligibility.
 */
export function protectsReleaseIntent(commits: readonly CommitPage[]): boolean {
  const files = commits.flatMap((commit) => commit.files);
  return (
    commits.length === 0 ||
    files.length >= 3000 ||
    commits.some((commit) => commit.parents.length > 1) ||
    files.some(
      (file) =>
        file.filename === "release-intent.json" || file.previous_filename === "release-intent.json",
    )
  );
}
