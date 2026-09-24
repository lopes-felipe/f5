# Upstream ledger schema 5 prerequisite

> Historical report. Later Phase 0 work supersedes the unfinished-prerequisite and
> rolling-window statements below; see [the Phase 0 validation report](phase-zero-validation.md).

> Historical schema-5 report. Storage and refresh mechanics are superseded by
> [the schema-6 ledger](../scripts.md#upstream-port-ledger); classification decisions remain preserved.

This change implements Phase 0b's ledger machinery and migrates the existing
500-commit window without changing its head (`196c8ea0d`). It does not complete
Phase 0b: the reviewed 1,836-SHA classification and target-window publication are
still outstanding. No approved feature phase is marked implemented by this change.
Existing schema-4 decisions carry `reviewStatus: "legacy"`; prefix suggestions are
pending and cannot pass the audit as reviewed decisions.

## Coverage and publication checks

The checker tests cover pinned first-parent refresh, a moving upstream head,
invalid pins, preservation of complete per-SHA records, schema migration,
idempotence, duplicate and missing classifications, ordered digests, and exact
synthetic 1,836-SHA coverage. Publication tests kill a subprocess between the two
canonical renames and verify recovery restores both original files. A live writer
and concurrent manual edits fail closed.

A disposable copy of the real manifest and ledger was refreshed twice against
`f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`. Both runs produced identical bytes;
the prior 500 records survived verbatim as historical entries, and all 500 new
window entries remained pending. This checks the mechanism against real history,
not the missing per-commit review. The checked-in manifest was left unchanged.

## Reproduced OAuth prerequisite failure

On merged main `9a09eee11`, the first full-suite attempt failed the OAuth manager
race test and reported an unhandled `CodexOAuthManagerError`: callback port 9 was
unavailable. The test waited for `startOAuthLogin`, but the port check rejected
before that call. The exhaustive Git matrix consequently did not run.

The revised test controls the preflight promise directly, waits until preflight
has started, emits the client-close event, then completes preflight with either
success or failure. Both paths must preserve the terminal failed status and release
the lease exactly once. `Effect.exit` observes failures immediately. This removes
the unrelated live-port dependency without changing production port checks or
OAuth behavior. The focused manager and callback suites passed all 20 tests.

A subsequent full run passed server unit tests and Git smoke tests, then detected
stale local dependencies: the installed Claude SDK was 0.3.261 while merged main's
manifest pins 0.3.280. `bun install --frozen-lockfile` synchronized dependencies;
no manifest or lockfile change was needed.

## Final verification

With the frozen dependencies synchronized, `bun run test:full` passed:

- All seven workspace test tasks passed, including 35 ledger checker tests.
- Server unit tests: 2,344 passed, 9 skipped.
- Git smoke tests: 8 passed.
- Server integration tests: 13 passed, 7 skipped.
- Exhaustive real-Git matrix: 107 passed.

`bun fmt`, `bun lint` (existing warnings), `bun typecheck`,
`F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`, and `git diff --check` also
passed. The upstream gate validates the preserved 500-entry window, not the
unfinished 1,836-SHA audit. No runtime capability or protocol version changed.
Local full-suite output: `/tmp/f5-ledger-full.log`.

## PR #28 review follow-up

Completed `ported`, `equivalent`, and `already-present` records now survive plan
regeneration unchanged; plan fields cannot overwrite their proof or add a workstream.
All Git history selection uses the fully qualified upstream remote-tracking ref,
and validation requires the audit target itself to be on that first-parent history.
Historical commit-object checks use a single batch Git query.

Validation is read-only, rejects an existing publication journal, and parses the
exact texts read by the file-pair reader. Refresh checks the old pair's digest before
fetching or publishing. Only writing commands perform recovery. Recovery retains a
fully published generation, distinguishes reused PIDs using OS creation times,
names malformed journal and stale-lock paths in errors, and preserves canonical
file permissions. Publication artifacts are ignored by Git.

Regression coverage includes all three completed dispositions, actual ambiguous
Git tags and branches in disposable repositories, a fork-only audit target,
read-only validation with a journal present, malformed journals, reused PIDs,
leftover recovery locks, finished publication recovery, permission preservation,
and missing historical commit objects. The ledger suite now has 49 passing tests.

Two review points did not require the suggested action: CI already fetched upstream
and required `F5_REQUIRE_UPSTREAM=1` at the reviewed commit; its fetch is now explicitly
non-pruning with a fully qualified refspec. The OAuth test remains because it fixes
the approved Phase 0a baseline failure encountered during this prerequisite. The
published commit was not rewritten to split that test out.

Review validation passed: `bun fmt`, `bun lint` (existing warnings), `bun typecheck`,
`F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`, and `git diff --check`.
`bun run test:full` passed all seven workspace tasks and all 107 exhaustive Git tests;
server test counts remain 2,344 unit, 8 Git smoke, and 13 integration passes.
Local output: `/tmp/f5-pr28-full.log`.
