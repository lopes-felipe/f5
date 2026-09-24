# Phase 1b: orchestration, persistence, checkpoints and settings

This completes the Phase 1b delivery across PRs #35, #36 and #37. The settings-only report for the first two commits of #37 remains a historical validation record; this report supersedes its scope and protocol statements.

The earlier PRs delivered iterative full replay, SQLite contention handling, receipt ownership, legacy event decoding, late-placeholder protection, durable checkpoint writes, bounded capture retries and empty nested-repository recovery. This PR retains those changes and finishes the remaining applicable ports.

## Behavior

- Checkpoints capture after terminal events, including aborted turns, rather than at intermediate diff events. Durable terminal session events remain the fallback. Running and interrupted state survives checkpoint publication in both database and live projections, including the web reducer.
- A checkpoint can use a project nested inside a Git repository. Worktree branch metadata follows a non-temporary branch selected by an agent in an exclusive worktree, using the existing expected-branch/path checks. A branch-only update does not overwrite provider session errors. File-search invalidation remains synchronous cache invalidation with lazy rebuilding; it does not await a new index scan.
- Capture copies the user's index into private staging, preserving stat metadata and racy-index checks. Streaming flag inspection detects assume-unchanged and manual skip-worktree flags; unsafe copies fall back to a fresh index. Sparse checkout rules are retained, including present out-of-cone files. The user's index is unchanged. Retained sparse path data is bounded at 32 MiB; non-cone sparse configurations that cannot safely reuse their index fail visibly instead of silently omitting changes.
- A missing worktree with a surviving branch is recreated before sending. Recreation checks whether the branch is checked out elsewhere and never creates or moves a branch. Startup preserves recoverable paths, and polling returns `worktreeMissing` without running Git in a missing directory. The queue reports missing refs or failed recreation as `worktree_missing`.
- Recreation takes a keyed path lock and a fail-fast SQLite lock shared by profiles through the real Git common directory. This introduces the coordinator needed for recovery. Phase 9 will extend it to setup, cleanup, terminal claims and file rewinds; those features are not part of this PR.
- Orphaned starting/running sessions without a turn ID become actionable restart errors. Existing terminal-receipt recovery and mismatched-binding safeguards remain in place. Completed turns get a full session idle window. Status-free task progress cannot revive completed background work.
- Removed custom models disappear from both server inventories and client choices. Invalid new script IDs are rejected; legacy IDs still render without crashing shortcut lookup. Missing workspace errors name the directory before provider spawn or recovery.
- Dead HTTP response/upgrade writes have error listeners. SQLite diagnostics report numeric conditions or schema issue tags without copying query values.
- Settings retain the original PR's disabled-instance fallback, redacted secret preservation and rollback on failed persistence.

Protocol version increases from 1 to 2 for missing-worktree response metadata. Existing version-gate recovery applies. There are no new settings defaults, provider capabilities or migrations.

## Verified equivalents and exclusions

- `2a7a449cc`: f5 derives provider choices from an array and reconciles registry membership, rather than upstream's settings-object overlay. Regression tests cover deleted `constructor` and `toString` instance IDs; the schema rejects `__proto__`.
- `41adccc83`: native Node HTTP routing has no upstream router parameter-length limit. The authenticated attachment regression uses a 167-character thread ID.
- `901db8966`: runtime ingestion uses filesystem metadata for Git detection, not a VCS subprocess. Terminal checkpoint work runs in its separate reactor. Late placeholders are rejected and do not overwrite completed checkpoints.
- `d17f46d76`: cache invalidation does not perform the upstream eager file-search refresh.
- `9cb40178a`: upstream's project CLI resolver does not exist in f5. This record is not applicable to the upstream-only project CLI subsystem.

Phase 1b closes with 28 ported records, four verified equivalents and one upstream-only exclusion, with no deferred records. The September classification remains the original review artifact. The ledger records these decisions individually, rather than claiming all upstream implementations were copied.

## Validation

On macOS arm64 with Node 26.9.0 and Bun 1.3.11, formatting, lint (nine existing warnings, no errors), typecheck and `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=1 bun run test:full` passed. The full run includes 2,454 server unit tests, eight Git smoke tests, 15 server integration tests and 131 extended real-Git tests, plus all other workspace suites. The browser suite passes all 429 tests. Focused checks additionally cover retained custom-model names and both older and newer status-free progress. Existing skips remain unchanged.

The initial full runs exposed an obsolete integration Git stub and a branch-only session refresh that erased a failed turn’s error state; both are corrected and the complete suite passes. The 5,000-file capture fixture remains within its 30-second Git deadline. No quantitative Phase 2 CPU improvement or resolution of the previously measured Phase 0 resource-limit failures is claimed. Online provenance and coverage validation runs after the implementation commit is recorded.

Real-Git destructive fixtures are confined to disposable temporary repositories. The ledger command integration tests now have an explicit 30-second timeout because they execute several Git subprocesses; product performance thresholds are unchanged.
