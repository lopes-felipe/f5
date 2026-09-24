# Phase 1a: Git safety and correctness

This PR implements Phase 1a of the September upstream port program. Phases 1b–14 remain unfinished. It does not refresh upstream coverage or change the September classification artifact.

## Behavior

- Checkout commands end with `--`, so stale branch names cannot restore matching files over local edits.
- A branch with commits ahead of a differently named upstream publishes its own fully qualified branch ref. Push remote precedence is the branch's `pushRemote`, `remote.pushDefault`, then the upstream remote. An existing `gh-merge-base` is preserved; otherwise the previous upstream branch is recorded. Git's tracking aliases for slash-containing remote names retain their original destination.
- Pushes have no application deadline. All Git subprocesses disable terminal credential prompts and interactive Git Credential Manager prompts. Worktree addition and removal have five-minute deadlines.
- Status and patch generation disambiguate refs from paths, including files named `HEAD`. Commit, range, review and checkpoint patches explicitly use `a/` and `b/` prefixes regardless of user Git configuration.
- Status polling returns its last successful result while the repository's resolved index is locked. Push and pull reject the locked state rather than acting on cached status. An initial status without a cache reports the lock.
- Missing worktrees are pruned successfully. New-thread setup can use a local-only base in a repository with a remote; only a confirmed absent remote ref permits fallback. Network and authentication failures remain errors.
- PR discovery probes bare branch names and filters by repository/owner identity, preserving fork PR creation's owner-qualified head argument. Feature branches do not inherit their base branch's PR. Default base fallback uses origin's symbolic HEAD, then local `main`, then local `master`.
- SSH remote detection accepts non-`git` usernames. Fetch errors provide fixed diagnoses without persisting remote stdout/stderr.
- Generated commits and PR descriptions receive bounded root `AGENTS.md` instructions; Claude writers also receive `CLAUDE.md`. Files outside the working directory and oversized instruction files are skipped. Explicit writing preferences remain included.
- Creating a branch in the picker replaces ASCII whitespace with dashes, previews that name, and checks collisions against it. Valid Unicode whitespace and case are preserved.

No protocol union, persisted schema, capability flag or setting default changes. Automatic pull and cleanup remain off. The existing renamed-PR-worktree push test now checks publication to the renamed branch; arbitrary local aliases no longer redirect writes to another branch.

## Ledger scope

The ledger assigns 22 commits to 1a. Seventeen are implemented here. The remaining five have concrete dispositions:

| Upstream    | Disposition    | Evidence                                                                                                                                  |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `4f1092cec` | Not applicable | f5 has no `newWorktreesStartFromOrigin` preference or conditional settings row. Its bootstrap directly selects the worktree base.         |
| `50791a053` | Equivalent     | f5's commit dialogs already say “branch”, including “Commit on new branch” and default-branch confirmations.                              |
| `62fbbe08a` | Not applicable | The upstream cross-version project-import Git-identity contract is absent from f5; f5 uses its own onboarding and an exact protocol gate. |
| `c7b14a866` | Equivalent     | f5 requests the complete branch list. It has no paginated client-runtime VCS store or partial-query coverage cache.                       |
| `ec3ec6f0b` | Not applicable | f5's sidebar trailing metadata uses a worktree indicator, not the upstream inline branch-name label whose color changed.                  |

Implemented records carry the implementation commit SHA and file evidence in `scripts/upstream-ports.json`.

## Verification

Regression tests use temporary repositories and local bare remotes. The credential failure test uses a loopback HTTP endpoint returning 401. Coverage includes stale checkout preservation, base-branch protection, explicit push remote precedence, existing merge-base preservation, Git tracking aliases, locked-index status, local-only bases, custom diff prefixes, fork identity collisions and default-branch fallback.

Passed on macOS:

- `bun fmt`
- `bun lint` (zero errors; nine pre-existing warnings)
- `bun typecheck`
- `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=2 bun run test:full`: 2,403 server unit tests, 8 Git smoke tests, 13 server integration tests, 119 extended real-Git tests, and all other workspace suites passed. Existing skipped tests remain skipped, including opt-in live Claude tests.
- `bun run --cwd apps/web test:browser`: 429 tests passed.
- Focused final GitCore/profile-environment checks: 31 tests passed.
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`: pinned upstream ancestry and complete ledger coverage passed.

Worker limits reduce contention on the shared development machine; test timeouts and assertions were not relaxed.
