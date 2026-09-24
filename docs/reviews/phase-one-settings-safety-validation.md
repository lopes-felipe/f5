# Phase 1b: settings safety

Historical report. The completed Phase 1b scope is recorded in [phase-one-b-completion.md](phase-one-b-completion.md).

This batch follows PR #36 at `200f964a39`. It implements upstream `62f568b88`, `ac4f1a2b6`, and `6d68677ff` using f5's existing settings service and profile-scoped secret store. It brings Phase 1b to 14 of 33 records; 19 remain unfinished.

Text-generation fallback respects explicit built-in instance enablement before legacy provider defaults. Persisted model preferences are retained. A redacted environment variable preserves the last matching inline sensitive value, migrating it into the secret store instead of losing it during the save.

Settings updates prepare and validate the next settings before changing secrets. Each mutation records the preceding value before calling the store, including operations that mutate and then fail. Failed secret writes, materialization or settings publication restore applied changes in reverse order. Newly created values are removed on rollback. The cache and change notification update only after settings publication succeeds. The mutation/publication sequence is uninterruptible, and ordinary settings reads share the existing write semaphore. Rollback failures are logged without secret values and do not replace the original failure.

This is recovery for errors within a running server, not a crash-atomic transaction across settings.json and the secret files. Process termination or power loss can still interrupt those separate files; durable journaling is outside this port. No database migration, protocol change, settings default or capability change is introduced.

Regression tests cover disabled-instance fallback, duplicate inline names with last-value precedence, redacted persistence, replacement/removal/new-secret rollback after an actual settings rename failure, and partial secret mutation before an injected store failure.

## Validation

On macOS with Node 26.9.0 and Bun 1.3.11: `bun fmt`, `bun lint` (nine existing warnings, no errors), `bun typecheck`, and `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=2 bun run test:full` passed. The full run includes 2,430 server unit tests, 8 Git smoke tests, 15 integration tests and 126 extended real-Git tests, plus all other workspace suites. The focused settings suite passes all 19 tests. Mandatory online ledger validation runs again after recording the implementation commit. Existing skips remain unchanged.
