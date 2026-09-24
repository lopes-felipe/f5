# Secret publication prerequisite: scope and validation

> Historical report. Later Phase 0 work supersedes the unfinished-prerequisite and
> rolling-window statements below; see [the Phase 0 validation report](phase-zero-validation.md).

This patch addresses only the secret-store race discovered during Phase 0a of the
September upstream-port program. It is **not** delivery of the merged port plan.
The review revision now passes the local gates listed below; this does not establish
a fix for the reported, unreproduced OAuth failure. Phases 0b–14 remain unimplemented; the ledger remains schema 4, the manifest remains pinned to
`196c8ea0d`, and no upstream SHA has been marked ported by this patch.

## Workspace and baseline evidence

The implementation workspace started at `de8b22959`, not the planning baseline
`290d261c9`. The initial fix is commit `196017bc0`. The reviewers' reports that their
workspaces contained pre-patch files describe different checkouts; the implementation
and validation here use the applied patch.

The first runnable `bun run test:full` at `de8b22959` failed in
`ServerSecretStoreLive > returns the persisted secret when concurrent creators race`:
one caller returned an empty byte array instead of the persisted 32-byte secret.
Server unit results were 2,223 passed, 1 failed, and 9 skipped. The command stopped
before the Git matrix. The raw output was saved locally as
`/tmp/f5-port-baseline.log`.

The reported unhandled `CodexOAuthManagerError` did not reproduce in this workspace.
The OAuth manager's 11 tests passed in the baseline and subsequent full-suite attempts.
This is not evidence that an intermittent OAuth issue is fixed; no OAuth code was changed.

## Review decisions

- **Plan scope:** accepted. This is a prerequisite patch, with no claims of
  ledger migration, 1,836-SHA classification, or approved feature ports.
- **Hard-link support:** accepted via the review's documented-requirement option.
  The service contract and environment documentation now state that random creation
  requires hard links. A simulated `ENOTSUP` failure is propagated with no published
  file or remaining temporary file. Copying or writing directly to the destination
  would reintroduce the race; rename could overwrite a concurrent winner.
- **Crash remnants:** the risk is real and also exists in the earlier `set` path.
  A blanket startup sweep or `remove` sweep is not adopted: another process may be
  writing the matching temporary file, and its age does not prove abandonment.
  Safe automatic reclamation needs cross-process ownership or lifecycle coordination.
  The operational documentation states that `remove` is not durable erasure and that
  orphan cleanup requires stopping every writer first. No automatic cleanup is claimed.
- **Test gaps:** accepted. Tests now force a real `AlreadyExists` collision with a
  known winner, assert cleanup of the losing temporary file, cover successful replacement
  and failed replacement preserving the old secret, and remove the import shadowing.
- **Directory fsync:** acknowledged as an existing durability limitation, documented
  explicitly. Atomic visibility is the scope of this fix. Portable directory durability
  and recovery after a sync error need a separate change; this patch does not promise
  survival of a power loss or secure deletion from snapshots and backups.

## Earlier full-suite attempts with the initial fix

`bun fmt`, `bun lint` (existing warnings), `bun typecheck`, and
`F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check` passed. The focused secret-store
and review-diff run passed 20 tests.

One `bun run test:full` attempt passed the entire workspace suite, including 2,226
server unit tests, 8 Git smoke tests, and 13 orchestration integration tests. The
exhaustive Git matrix then reported 101 passed and 6 failures, all 15-second timeouts
in `GitCore.extended.ts`:

- Remote-tracking merge-base PR diff content.
- Branch recency ordering.
- Default-branch ordering.
- Checkout's upstream behind-count refresh.
- Returning checkout before background refresh completes.
- Checkout with slashes in a remote name.

A subsequent `F5_TEST_MAX_WORKERS=1 bun run test:full` failed the branch-range test in
`ReviewDiffService.test.ts` at the same 15-second limit (2,225 server unit tests passed,
1 failed, 9 skipped), so its Git matrix did not run. Outputs were saved locally as
`/tmp/f5-port-full.log` and `/tmp/f5-port-full-serial.log`.

A disposable-repository trace showed that system-configured Git hooks ran during a
fixture commit: about 1.2 seconds for that commit, mostly in hooks. This demonstrates
fixture overhead, not the cause of every timeout. Hooks, timeouts, and gates were not
disabled or relaxed.

## Review validation

On macOS arm64, Node 26.9.0, Bun 1.3.11, and Vitest 4.1.0:

- Ran the original seven-test file from `de8b22959` against that commit's secret-store
  implementation in 200 separate Vitest processes: **138 passed, 62 failed**. The
  captured failure was the concurrent-creation assertion returning an empty array.
- Ran the revised twelve-test file in 200 separate Vitest processes:
  **200 passed, 0 failed** (2,400 passing test executions).

Each process used `bun run --cwd apps/server test:file <file>`. The baseline source
and test were copied to uniquely named temporary siblings so relative imports stayed
unchanged; only the test's implementation import was redirected. Both temporary
files were removed afterwards. Neither the branch nor tracked implementation was
switched or overwritten. Local artifacts: `/tmp/f5-secret-review-stress.py`,
`/tmp/f5-secret-review-stress.json`, and the first failing baseline output at
`/tmp/f5-secret-review-stress-before-failure.log`.

Fresh review checks also passed: `bun fmt`, `bun lint` (four existing warnings),
`bun typecheck`, and `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`. These
checks validate the applied review changes, not the reviewers' separate checkouts.
The ledger check covers the existing 500-entry manifest; it is **not** the planned
1,836-SHA audit.

The fresh `bun run test:full` exited successfully after the review changes:

- All seven workspace test tasks passed.
- Server unit tests: 2,229 passed, 9 skipped (including all 12 secret-store tests and
  all 11 OAuth manager tests).
- Git smoke tests: 8 passed.
- Server integration tests: 13 passed, 5 skipped.
- Exhaustive real-Git matrix: **107 passed, 0 failed**.

Output: `/tmp/f5-secret-review-full.log`. The command used the normal worker settings
and unchanged timeouts and hooks, after typechecking and stress tests had finished.
This successful run does not establish that the earlier intermittent Git timeouts
are fixed; their history above is retained. No Git or OAuth implementation was changed.
