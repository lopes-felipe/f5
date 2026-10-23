# October Git security verification

This record supplements #20440 (`73d70a444b70c735d990252b453d9b7a4ca63e17`)
and #14917 (`4ce6a51a4c4bbc9a2fc9e371ecb446851f953482`). The upstream
diffs were read alongside f5's process wrappers and Git argument builders.
It does not complete the other security or verify-first obligations.

## Process configuration

Both `GitService` and direct `runProcess` Git/GitHub CLI calls append
`safe.bareRepository=explicit` to inherited configuration. Windows additionally
receives `core.longpaths=true`. GitHub CLI inherits the policy because checkout
and clone can launch Git. Other executables keep their existing environment.
Configuration counts preserve existing credential helpers and author settings;
Windows count spellings are reconciled, while POSIX remains case-sensitive.
Invalid counts produce bounded errors without echoing their value. Caller-owned
environment objects are not mutated. No user configuration file is changed.

A real bare-repository fixture rejects implicit discovery but permits explicit
`--git-dir` selection. Git versions below 2.38 do not enforce this upstream
configuration setting; this change does not claim otherwise. Existing owned
bare fixtures now select their repository explicitly, retaining their assertions.
The process-runner and service tests failed before the policy was installed.

Windows tests cover mixed environment casing and delivery of long-path
configuration to an actual Git process. Removing the service policy made that
delivery test fail. They do not certify native Windows filesystem behavior.

## Arguments and repository mutations

The audit covered GitCore command builders, checkpoint storage, profile Git
configuration, PR checkout discovery, review diffs and direct workspace readers.
Path arguments use option terminators and literal pathspecs where appropriate;
revision operations terminate option parsing or use previously resolved OIDs.
The shared `gitConfigArgs` helper retains its fixed key allowlist.

Worktree creation and recovery reject empty, NUL-containing and option-shaped
refs before Git calls or ownership allocation. A terminator before a worktree
path alone is insufficient because Git can internally invoke `git branch` with
the new branch name. Tests preserve checkout contents, real-index bytes and
branches when rejecting these names.

Two additional failing-before real-Git reproductions found destructive branch
deletion behavior. An option-shaped expected SHA could bypass comparison, and
a symbolic branch ref could cause deletion of its target. Conditional deletion
now requires a complete nonzero SHA, ends option parsing and uses `--no-deref`.
Tests retain the target branch and HEAD and verify that only the alias disappears.
A hostile configured remote name also exercises both branch and PR fetches
without executing its option-shaped contents.

Upstream's arbitrary PR file-content endpoint has no f5 equivalent. f5's forge
provider exposes PR-specific file pages and patches; its local revision reader
is workspace-scoped and terminates `cat-file` options. GitLab/Forgejo use HTTP,
so upstream's `glab`/`tea` CLI argument changes have no corresponding call sites.
GitHub HTTP transport remains separate workstream 15g.

## Verification

The exhaustive Git matrix passes 161 cases and the smoke matrix passes eight.
The focused environment, process runner, service and Core suites pass 68 cases.
The larger server suite and repository gates are recorded in the accompanying
[review response](./upstream-october-review-response.md). These results do not
waive a failed full-suite gate or mark all of 15v complete.
