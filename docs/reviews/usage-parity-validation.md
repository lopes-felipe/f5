# Usage parity review and validation

Implemented on 2026-09-05. The token-scope correction is a separate commit in this PR
(originally `ed97319`, cherry-picked as `42e4aa3`).
Existing unrelated working-tree edits were preserved. No persisted usage facts were rewritten.

## PR preparation on current main

The usage changes were isolated onto `feat/usage-account-dashboard` from `72efe49`.
The workflow-question and PowerShell display changes are already merged in PRs #4 and #3
and are excluded here. The original stash remains intact.

Fresh checks passed: formatting, lint (four existing warnings), all eight workspace
typecheck tasks, the web production build and bundle budget, 47 focused server usage
tests, all 11 usage dashboard browser tests, and all 107 exhaustive Git tests.
The earlier Git failures listed below describe the original pre-merge environment;
they did not recur in this run. Live account checks listed below remain outstanding.
The fresh `bun run test:full` run also encountered failures in server filesystem,
legacy migration, terminal, and WebSocket tests in this Windows/Bun-as-Node environment;
it is not a passing full-suite result.

## Visual review

These are browser-rendered fixture screenshots, not live billing/account captures.

- [Before](usage-before.png): previous Codex-centric page.
- [After](usage-after.png): disjoint chart composition, independent account sections, and Claude unknown/zero quota states.

The images are included in this PR. No PR was created during the original implementation.

## Passing checks

- `bun fmt`
- `bun lint` (four existing unused-disable warnings)
- `bun typecheck`
- `bun run --cwd apps/web build`, including the bundle budget (about 1.26 MB initial JavaScript, 49.9% below the budget baseline)
- `bun run --cwd apps/server vitest run src/usage src/provider/Layers/ClaudeUsageProbe.test.ts src/persistence/Layers/UsageFacts.test.ts`: 47 tests
- `bun run --cwd apps/web test:browser src/components/usage/UsageDashboard.browser.tsx`: 11 tests
- `bun run upstream-ports:check`: ledger valid (500 frozen commits); remote provenance verification skipped by the script because the authoritative upstream remote is unavailable. The manifest was not refreshed.

The original `codexAccountUsage.test.ts` is unchanged. Tests include the real SDK stdio control-request harness, prompt-free initialization and usage, exactly-once abort on success/failure/interruption/timeout, capabilities reuse, scope retirement, sixteen queued accounts, two-probe concurrency, TTL/cooldown, independent Codex failures, provider predicates in both SQL branches, mixed-provider composition, older-server decoding, query-connected rejected refreshes, focus/reconnect, memory-only progress polling, and accessible unknown/zero meters.

## Repository failures and environment limits

`bun run test:full` was run and failed in existing desktop backend environment tests: four path assertions expect POSIX paths on Windows. The command stops before the exhaustive Git matrix, so that matrix was also run explicitly.

`bun run test:server:git:extended`: 105 passed, 2 failed:

- GitCore: caps captured output when `maxOutputBytes` is exceeded.
- GitCore: refreshes upstream behind count after checkout when the remote branch advanced (wait timeout).

The initial server baseline also failed before account integration edits: 30 failed files, including provider/executable, terminal, filesystem, and WebSocket cases. A focused run of the extended usage transport test reaches the existing WebSocket failure before receiving welcome: `ws.extensions.includes is not a function` at `apps/server/src/wsServer.ts`. In this shell, the executable named `node` reports `process.versions.bun === "1.4.1"`. This is baseline information, not a passing full-suite result. These unrelated runtime/platform paths were not changed.

## Live Claude validation

A real prompt-free structured usage read succeeded using the local OAuth-authenticated Claude Pro home. At that instant the five-hour window was 34% and the weekly window was 11%; the response also included a model-scoped Fable window and disabled extra usage. No session/behavior totals or monetary extra-usage amounts were incorporated into F5 facts.

The local projects history contained 183 files totaling 30,366,002 bytes. The read took 1,084 ms. Process inventories before and after showed no additional Claude process. This measured history supports retaining the five-minute TTL; it does not establish latency for substantially larger histories or prove transcript scanning is skipped/cached.

`bun run dev` was attempted. Overriding the inherited conflicting `T3CODE_PORT` allowed startup, but the live browser could not establish its authenticated WebSocket connection in this dev environment. The following remain outstanding before merge:

- Compare the subscription windows directly with the interactive Claude Code `/usage` display.
- Validate unavailable-limit behavior against a real non-subscription configuration, if available.
- Validate an actually unsupported older custom CLI. Missing methods/RPCs and invalid Windows shims are covered automatically; the live read used the bundled executable.
- Complete the live page refresh-after-cooldown and disable/re-enable walkthrough. The equivalent browser interaction states pass in the query-connected harness.

The subscription API path itself is verified; the outstanding checks above are not represented as passed.
