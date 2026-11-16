# Server performance and storage (section 5.4) validation

Validation results moved from [performance.md](../performance.md#server-performance-and-storage-roadmap-54).

A full paired server run (5 warmups, 30 repetitions) passed `perf:compare` with
`orchestration.assistant-stream` as the CPU target. Local reports are
`.performance/section54-final-baseline.json` and
`.performance/section54-final-after.json`.

| Streaming metric          |       Before |       After |
| ------------------------- | -----------: | ----------: |
| Wall time p95             | 10,068.59 ms | 1,069.81 ms |
| Process CPU p95           |  9,363.11 ms |   729.33 ms |
| Per-delta latency p95     |    633.61 ms |    76.97 ms |
| Event rows                |        2,070 |         143 |
| Projection SQL statements |       61,622 |       3,812 |
| Event-loop delay p99      |     16.64 ms |    15.04 ms |

An earlier attempt exceeded the unaffected slow-reader replay regression gate;
a quiet repeat passed. Retain the raw reports when comparing on another machine.
The interactive fixture was updated afterward for the native-operation list and
disk-space reads used by the current UI; combined coverage reports therefore
need the refreshed fixture/harness digests.

Formatting, lint (26 existing warnings, no new warnings), typecheck, build,
Bun readiness, SDK/protocol audits, packaged ESM/CJS and a locally built
standalone executable maintenance launch, the
Git smoke suite and all 136 extended Git cases pass. Focused tests cover streaming
order for Codex and a non-allowlisted driver, immutable retry payloads, full-text
completion recovery, backup ownership/restore/storage limits, incremental skill
scans and deleted roots, migrated summaries, and stale detail-query cancellation.
The changed-feature browser batch passes all 36 tests.

Initial full verification was not green in this environment: the full test command was
attempted, and a continuing workspace run exposed process-birth identity failures
in upstream-ledger and launcher tests, a workspace-watch race test, and the passive
Codex reconciliation test. A clean server run passed 4,116 tests with those five
server failures remaining. The full browser suite passed 790 of 791 tests; its
remaining failure concerns worktree-default branch inheritance. Desktop smoke is
blocked by the local Swift manifest/toolchain and missing Electron installation.
Authenticated live-provider certification was not run.

The full storage gate completed 35/35 exports with an external read transaction.
Its event-loop delay p99 was 13.83 ms and longest application SQL execution was
17.28 ms. Neither R12 trigger tripped. The report is
`.performance/section54-storage-gate-full.json`; it uses the refreshed interactive
fixture and includes the extra storage-gate observations.

The full interactive run completed the ten-minute soak and retained all eleven
memory samples, but failed its terminal subprocess-activity assertion: 59,738
terminal output events and zero activity transitions were observed. The process
poller depends on `ps`, which this environment denies. This run does **not**
establish passing interactive coverage. Its raw browser measurements remain at
`.performance/section54-interactive-full.json.browser.json`: 20.00 updates/second
per thread, no unknown RPCs, browser heap growth 3.06 MB and server heap growth
−0.51 MB over 600 seconds. A full passing rerun on a host permitting process-table
inspection remains required.

The standalone helper was exercised in a real locally built Node 26.11.1 SEA,
including an empty provider installation. This verifies its early maintenance
route; it does not replace the release archive smoke with the pinned Node 26.10.0
runtime and packaged native dependencies. The archive smoke now also requests a
backup with a clean PATH.

PR review follow-up adds regression coverage for exhausted/permanent batches,
legacy unregistered attachments, previously restored registry paths, settings
credential redaction/encryption, failed scheduled exports, interrupted partials,
clock rollback, failed skill refreshes and normally ended watch streams. Scheduled
results are persisted and shown in Storage settings. The passive reconciliation
CI failure was traced to a test runtime missing the newly required skill-sync
service, and that fixture is now corrected.

Review follow-up verification passes formatting, formatting check, lint (26 existing
warnings), all eight typecheck tasks, build, Bun HTTP backup export, 180 focused
server tests, all 125 WebSocket tests and 40 browser tests. The server performance
smoke also passes (stream per-delta p95 about 75 ms, 143 event rows). A new full-suite
attempt still stops at the two upstream-port migration process-identity failures
on this host. No new full interactive soak or paid provider run was performed.
