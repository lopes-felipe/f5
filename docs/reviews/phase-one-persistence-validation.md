# Phase 1b: replay and persistence recovery

This is the first Phase 1b PR, based on merged Phase 1a (`5c519afa2c`). It implements six of the 33 records assigned to Phase 1b. The other 27 remain deferred in the ledger: checkpoint capture, settings, session/model lifecycle, workspace handling and worktree recreation still need implementation or equivalence verification. Worktree recreation depends on the Phase 9 lifecycle coordinator. Phases 1c–14 also remain unfinished.

## Changes

- Event replay uses iterative pagination, releasing consumed pages. Startup catch-up, snapshot fallback, dispatch-failure reconciliation and projection bootstrap explicitly request all remaining events. The public `readEvents` API remains bounded to 1,000 events per call.
- Node sets a five-second SQLite busy timeout when opening each physical connection. Bun's single connection receives the timeout before WAL setup and migrations; its driver's automatic WAL setup is disabled to preserve this order. The profile instance lock's zero timeout is unchanged.
- Persisted messages without `turnId` decode as `null`.
- Reusing a command ID for a different aggregate is rejected before replaying its receipt, without replacing the original accepted or rejected receipt. Bootstrap recognizes this as definitely uncommitted delivery.
- A late missing-checkpoint placeholder cannot overwrite an existing ready/error checkpoint in SQL, matching the in-memory projection's handling.

No settings defaults, database migrations, advertised capabilities or new wire event shapes are added. The legacy message change accepts old input while preserving the current output shape, so no protocol bump is required. Client overflow/resynchronization and the Phase 2 performance gates remain separate work; this PR does not claim to satisfy them.

## Regression coverage

- 20,000 stored events traverse multiple replay pages in order; ordinary reads remain capped and explicit partial/zero limits are respected.
- Persistent restart tests exceed 1,000 events for both warm catch-up and failed-snapshot fallback.
- Dispatch-failure recovery reads a persisted backlog exceeding 1,000 events.
- Projection bootstrap replays 1,001 legacy messages whose stored JSON omits `turnId`, advances all projector cursors, and preserves a ready checkpoint after a late placeholder and repeated bootstrap.
- Accepted/rejected command receipts resist cross-project, cross-thread and cross-kind reuse; the original receipt remains usable.
- Separate-process contention tests exercise Node's native client and Bun's production persistence layer while another connection holds a write transaction. Both complete after that transaction commits.

The exact upstream records and implementation commit are recorded in `scripts/upstream-ports.json`. Coverage boundaries and the September review artifact are unchanged.

## Validation results

Validated on macOS with Node 26.9.0 and Bun 1.3.11:

- `bun fmt`, `bun lint` (zero errors, nine existing warnings), and `bun typecheck` passed.
- `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=2 bun run test:full` passed: 2,412 server unit tests, 8 Git smoke tests, 15 server integration tests, 123 extended real-Git tests, 1,628 web unit tests, 205 contracts tests, 374 shared tests, 105 scripts tests, 104 desktop unit tests and 16 ACP tests. Existing opt-in/skipped tests remain skipped.
- The online ledger check is run again after recording the implementation commit, along with the scripts suite. Only the six delivered records change disposition.

The first full run overlapped the final bootstrap conflict-classification edit and failed that new test. A fresh full run against the final code passed; no assertion or timeout was relaxed. Worker limits reduce contention on the shared machine. There are no UI or desktop behavior changes in this PR.

## PR review follow-up

Accepted receipts now use the command's target aggregate, matching rejected receipts. Pin events still belong to the global pin stream. For older accepted pin receipts, retry checks the event at the receipt's sequence and verifies its command ID, event type and original anchor thread. This preserves restart-safe retries without accepting a different anchor or requiring a migration.

Command-ID conflicts now fail queue dispatch immediately with their original diagnosis, and bootstrap cleanup failures are appended to the conflict error. The thread SQL projector also ignores late missing-checkpoint placeholders, preserving sidebar timestamps and the latest turn alongside the captured checkpoint.

Regression coverage adds both pin commands with current and legacy receipts, immediate queue failure, conflict cleanup reporting, unchanged thread rows, and an exact projector-cursor count. SQLite polls allow 30 seconds for child startup; the child measures the actual INSERT and must wait at least 200 ms. The integration test has a 45-second envelope for startup and shutdown. The production busy timeout remains five seconds.

The end-to-end replay tests retain real command dispatches, since bulk insertion would bypass the receipt, projection and transaction paths they verify. The lower-level 20,000-event test already uses a bulk insert.

Review validation passed: formatting, lint (zero errors; nine existing warnings), typecheck, all 72 focused tests, and the full suite including 2,416 server unit tests, 15 server integration tests and 123 real-Git tests. The online ledger check and scripts suite are repeated after recording the review commit. The six-port scope and coverage boundaries are unchanged.
