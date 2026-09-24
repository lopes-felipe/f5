# Upstream performance baseline

The Phase 0 harness collects server component measurements and a production-browser,
WebSocket and native-terminal soak. Both reports are required. The pinned original
baseline is `290d261c9c9daa0c469b312d7f62dfd4ea9b9698`; use its runtime code and
frozen dependencies when collecting it. This is measurement tooling, not a runtime
performance port. Existing baseline failures remain failures until their approved
Phase 2 fixes meet the gates.

## Run server measurements

From the repository root, with dependencies installed and the same Node version in both checkouts:

```sh
bun run --cwd apps/web build
bun run perf:server --smoke
bun run perf:interactive --smoke
bun run perf:server --output=.performance/server-before.json
bun run perf:interactive --output=.performance/interactive-before.json
# After the relevant implementation changes, on the same machine/runtime:
bun run perf:server --output=.performance/server-after.json
bun run perf:interactive --output=.performance/interactive-after.json
bun run perf:compare .performance/server-before.json .performance/server-after.json
bun run perf:compare .performance/interactive-before.json .performance/interactive-after.json
# A change targeting CPU must additionally improve its named scenario by at least 20%:
bun run perf:compare .performance/server-before.json .performance/server-after.json terminal.ingest-20
```

Run measurements alone, without the test suite, builds or other benchmarks in
parallel. Full runs use five warmups followed by 30 measured repetitions. Smoke
runs use one warmup and two repetitions and cannot be used for comparisons. The
fixture sizes are identical in both modes. No timing assertions run in ordinary
CI; correctness tests cover fixture content, sample handling and gate decisions.

Reports live in ignored `.performance/` files. Existing report files are never
overwritten. Reports include every raw wall-clock and process-CPU sample, source
commit and dirty state, fixture and harness digests, OS/hardware, actual installed
dependency versions, dependency-lock digest and runtime versions. Browser version
is explicitly null for this server-only runner. A report is published only after
all scenario correctness checks and resource cleanup succeed.

The acquisition command records existing resource-limit violations and prints
`FAIL` without failing the measurement itself. This permits collecting a baseline
of known defects. **Comparison rejects those violations**, even when timings
improve. It also rejects smoke runs, incomplete or missing scenarios, different
fixture/harness digests, incompatible hardware/OS/runtime, disappearing or changed
resource bounds, and unknown CPU target names. Dependency versions may change
between runs; both versions are recorded for review.

The p95 uses nearest-rank selection. An unaffected latency fails only when its
regression exceeds both 10% and 20 ms. Named CPU targets must improve p95 process
CPU by at least 20%. CPU values cover the Node benchmark process; they **exclude
Git and the concurrent SQLite child process**, so Git CPU optimizations require
additional instrumentation before that gate can be evaluated.

## Workloads and limits

The checked-in fixture specification is
[`fixtures.json`](../scripts/lib/performance/fixtures.json). Its generator has a
fixed seed, timestamps and pinned content digest. Data is generated outside timed
regions. All databases, logs, repositories and local bare remotes are disposable
under the OS temporary directory; user repositories, credentials and profiles
are not used. Git fixture construction disables host configuration and automatic
GC. Local transport is enabled only for fixture submodule setup.

| Measurement                            | Production path and workload                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal.ingest-20`                   | Twenty `TerminalManagerRuntime` sessions receive 40 × 4 KiB chunks each, with Unicode, ANSI and CRLF. History is cleared outside timing.                                                                   |
| `terminal.persist-reconnect-20`        | Close all sessions, flush production persistence, then reopen and read histories.                                                                                                                          |
| `replay.20000`                         | Production SQLite migrations and event store; decode 20,000 ordered events, checking every sequence. The explicit replay limit avoids conflating the known default 1,000-event truncation with throughput. |
| `replay.slow-reader-with-writer`       | Same stream, pausing after each 200 events while a separate physical SQLite connection/process writes every 5 ms.                                                                                          |
| `replay.cancel-after-1000-with-writer` | Cancel consumption at 1,000 events with the writer still active; subsequent samples must replay from the start successfully. This is stream cancellation, not a WebSocket disconnect.                      |
| `git.status-large-nested-submodules`   | Production `GitCore.statusDetails` over 10,000 files, three nested repositories and two real submodules. Assert the known tracked modification is returned.                                                |

Terminal byte limits are checked separately after injecting a line larger than
4 MiB. Current history is line-bounded and can exceed this planned byte ceiling;
the harness must preserve that result until Phase 2 fixes it. The PTY adapter
delivers deterministic bytes instead of starting interactive shells. Process
discovery/polling cost and native PTY integration are **not measured** here.

## Browser, transport and retained memory

The user revised the soak duration from 30 to **10 minutes** on 2026-09-24.
Retained growth is measured over the final **5 minutes**, with the original 5% and
10 MiB thresholds unchanged. Five warmups and 30 timing repetitions also remain
unchanged. This shorter run is not evidence of 30-minute stability.

The interactive runner serves the **production-built application**, with deterministic
read-model RPC responses and the production WebSocket push controller. Playwright
uses the real router, composer, message rendering and WebSocket client. The fixture
server is not a measurement of production HTTP static-asset serving. It provides
10,000 messages, 50 image attachments, ten 1 MiB command outputs and ten streaming
threads. All ten threads are hydrated before streaming starts; each receives 20
updates/second through real sockets. Unknown RPC methods fail the run.

Measurements use browser event/paint timestamps, excluding automation transport
latency. Startup ends when the small thread and composer paint; warm switching
ends when the last large-thread message paints. Composer timing starts at captured
`beforeinput` and ends two animation frames after its DOM update, both idle and
under streaming. Renderer process CPU is recorded through Chromium's process API.

A separate socket pauses TCP reads until the production send controller rejects
queued frames and closes it. Each trial reconnects while a separate physical
SQLite connection writes. The legacy 1013 and future 4409 overflow codes are
accepted; the 8 MiB / 2,000-event limits remain fixed. This measures overflow and
reconnection, not the Phase 2 snapshot-resynchronization feature.

Every full interactive run then keeps ten streams, twenty **native PTYs** and the
SQLite writer active for 10 minutes. Terminal children have a bounded lifetime and
an owned foreground descendant, exercising the production process poller. Terminal
output and SQLite rows are bounded; terminal histories are loaded from full disposable persisted logs before timing
so their initial growth does not consume the shorter observation window; memory is sampled after garbage collection at
minutes 0 through 10. Reports retain browser/server heap, server RSS, terminal
history bytes and cumulative renderer/server CPU. Child process CPU is excluded.
The final five-minute heap growth must be ≤ 5% **and** ≤ 10 MiB for each measured
process and their sum. All 11 samples are required; a short smoke cannot qualify.
Raw browser reports and minute-progress files remain available if a run fails.

The server runner also observes real replay SQL page row counts and serialized
bytes, and measures legacy base64 attachment decoding/persistence/release using
eight 1 MiB images. These are the existing ingress path, not future generic HTTP
uploads. Replay/upload observations describe those buffers, not whole-process
heap. The separate soak measures retained heap.

## Reproducing the pinned baseline

Create a detached disposable checkout without changing its production source:

```sh
git worktree add --detach /tmp/f5-phase0-baseline 290d261c9c9daa0c469b312d7f62dfd4ea9b9698
```

Copy only the harness directories `scripts/lib/performance`,
`apps/server/scripts/performance`, the files `scripts/performance.ts`,
`apps/server/vitest.performance.config.ts`, and
`apps/web/scripts/performance-browser.mjs` into that checkout. Run
`bun install --frozen-lockfile` and build its web app there. Verify that `git diff`
contains no production-source changes (installation may regenerate the MSW public
worker; preserve the checked-in baseline version). Invoke the copied runner using
`bun scripts/performance.ts` and `bun scripts/performance.ts interactive`, since
the baseline's package manifest has no performance commands. Keep its original
lockfile and dependencies; never substitute the candidate's node_modules.

Run baseline and candidate sequentially on the same machine and runtime. Reports
must have matching fixture and harness digests. The source-dirty flag includes
untracked harness files in the old checkout; retain a separate production-source
verification with the results. Machine-specific raw reports remain untracked.
Check that each revision has both complete reports before comparing:

```sh
bun scripts/performance.ts coverage .performance/server-before.json .performance/interactive-before.json
bun scripts/performance.ts coverage .performance/server-after.json .performance/interactive-after.json
```

Coverage validation checks required scenarios, sample counts, fixed resource limits,
matching source/environment metadata and the complete memory duration. It reports
measured failures separately: complete coverage is not a passing performance gate.
Use both comparisons; neither report alone establishes complete Phase 0d coverage.
