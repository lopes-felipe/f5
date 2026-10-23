# Upstream performance baseline

> Contributors: the performance harness, baseline and the budgets changes must meet.

**Contents:** [Run server measurements](#run-server-measurements) · [Workloads and limits](#workloads-and-limits) · [Browser, transport and retained memory](#browser-transport-and-retained-memory) · [Reproducing the pinned baseline](#reproducing-the-pinned-baseline) · [Server performance and storage (roadmap 5.4)](#server-performance-and-storage-roadmap-54)

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
4 MiB. The pinned original baseline is only line-bounded and exceeds this ceiling.
The Phase 2 terminal implementation retains at most 5,000 lines and 4 MiB of UTF-8
content, dropping whole old lines first and truncating oversized lines only at
code-point boundaries. Live output is not truncated. The PTY adapter delivers
deterministic bytes instead of starting interactive shells. Process discovery/polling
cost and native PTY integration are **not measured** by the server-component runner;
the interactive soak exercises the shared two-second process poller with native PTYs.
See [the terminal validation report](reviews/phase-two-terminal-validation.md).

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

The SQLite checkpoint gate can also run independently:

```sh
bun run perf:server sqlite-checkpoint --output=/tmp/f5-checkpoint-report.json
```

It uses five warmups and thirty measured repetitions. Each repetition prepares a
40 MiB WAL before timing, then measures event-loop delay while the production
Node checkpoint worker drains it. Every measured p99 must be below 50 ms. The
report records fixture, harness, dependency and machine metadata. This is an
absolute checkpoint-latency gate; it does not establish comparative CPU gains or
replace the other server, browser or retained-memory gates.

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

## Server performance and storage (roadmap 5.4)

The assistant-stream scenario sends bounded bursts of 32 concurrent deltas per
stream and measures each delta through its projected text. Waiting for each delta
before publishing the next would prevent a batching implementation from being
measured. The fixture still uses four streams, 500 deltas each, 2,000 seeded
messages per thread, and tool/command interruptions every 50 deltas.

For a paired coalescing comparison on the same code and hardware:

```sh
F5_PERF_STREAM_COALESCE=0 bun run perf:server --output=.performance/stream-before.json
bun run perf:server --output=.performance/stream-after.json
bun run perf:compare .performance/stream-before.json .performance/stream-after.json orchestration.assistant-stream
```

`F5_PERF_STREAM_COALESCE` is a benchmark-only override of the driver allowlist;
it does not configure the application. Production coalescing is allowed only for
Codex, whose assistant item completion includes the full final text. Claude and
other drivers retain their existing delivery behavior. Batches flush at 40 ms or
2 KiB, before other events on that thread, on controls, and during scope close.
Retries preserve the first event’s command ID and immutable text. After three
failed attempts, or a permanent rejection, the batch is dropped and logged. Later
deltas for that message wait for its authoritative completion so the stored text
stays a valid prefix. Other events and other threads continue. Set
`F5_COALESCE_STREAMING_DELTAS=false` before startup to disable batching independently.

Non-handling projector skipping now runs within the existing command transaction;
each projector cursor advances once at the final sequence. SQLite helper ownership
and pragma tuning remain measurement-gated. `synchronous = NORMAL` is not enabled.

The storage gate can run the same ingestion workload while each repetition
exports a backup and a separate SQLite process holds a read transaction:

```sh
F5_PERF_STREAM_STORAGE_GATE=1 bun run perf:server --smoke --output=.performance/storage-gate-smoke.json
F5_PERF_STREAM_STORAGE_GATE=1 bun run perf:server --output=.performance/storage-gate.json
```

This reports the longest application SQL execution as well as event-loop p99,
and asserts that every concurrent export completed. Child archive/reader CPU is
not included in the parent process CPU measurement. The normal paired P2
comparison runs without this additional workload.

### Section 5.4 validation

Results are recorded in [reviews/server-performance-storage-validation.md](reviews/server-performance-storage-validation.md).

## Stability instrumentation

The Node SQLite adapter records successful and failed execution durations on both
row and positional result paths. Statements taking more than 100 ms log a warning
containing the duration and at most 160 characters of the source SQL; bound
parameters and expanded SQL are never logged. Unit tests inject elapsed time into
a recursive CTE check, rather than asserting a machine-dependent execution time.

The push bus records encoded frame bytes, replaced/subsumed coalesced pushes and
slow-client closures. Frame/replacement labels contain only static channel
families, never workspace paths, thread IDs or MCP identities. Queue depth is
sampled every 250 ms, at the same cadence as the existing event-loop-delay sampler.
Repeated callbacks from an already closed client do not count another close.

The four-stream workload includes an uncoalesced `claudeAgent` variant beside
Codex. Delta latency ends at the production push bus's send callback. Report-only
`diagnostics` contain queue entries/bytes, SQLite page growth/WAL bytes, event-loop
percentiles, SQL admission/execution times, ingestion lookup, in-memory projection,
per-projector time/counts and push admission. Snapshot transactions, worker entries,
bytes/age/failures and shutdown phase durations also have production metrics. The
optional stage probe is disabled in normal execution and never records SQL parameters.

The 2026-10-19 smoke used one warmup/two repetitions: Codex delta-to-push p95 was
68.46 ms; uncoalesced Claude was 538.43 ms, with 80,264 SQL statements in its busiest
repetition. This validates the C0 harness and identifies a projection workload to
measure; a smoke run certifies no performance improvement. Browser operation
inventories and full before/after qualification remain required.

### Baseline qualification status, 2026-10-19

The server foundation baseline is pinned at commit
`3bdf4bf66cf1287453c8a94e71c63f767eab4b50` (tree
`d2ec874d0f02bc3982702f9db1c9da77ab5091a5`). It was collected in a clean,
isolated checkout with Node 24.13.1, Bun 1.3.11, five warmups and thirty
repetitions, without concurrent builds or tests. The complete local report is
`.performance/stability-c0-foundation-full-20261019.json`; preserve that report
as a CI artifact when publishing this change. Earlier smoke reports remain
exploratory and cannot qualify improvements.

Reproduce with `git worktree add --detach /tmp/f5-stability-c0
3bdf4bf66cf1287453c8a94e71c63f767eab4b50`, install the frozen lockfile, then run
`bun run perf:server --output=.performance/baseline.json` in that checkout.
Collect candidates sequentially on the same host and runtime and use
`bun run perf:compare`; incompatible metadata never qualifies a comparison.

All existing server resource checks passed. Codex delta-to-push p95 was 79.66 ms;
uncoalesced Claude was 823.50 ms. Claude's arrival-sampled command queue p95 was
one entry and event-loop delay p99 was 28.95 ms. Retained read-model heap was
51,800,456 bytes. These measurements justify measuring the append projection
optimization; they do not enable Claude coalescing, a SQLite worker, or read-model
slimming. Browser and desktop qualification remain separate.

The interactive fixture now answers `worktrees.getTransition` and
`worktrees.threadState`; missing responses previously crashed the production chat
route. Local smoke diagnostics ran, but full interactive qualification failed
because the production process-table probe returned `spawn EPERM`. Full runs now
check that capability before allocating the fixture or starting the soak. Rerun
qualification on a host permitting that probe and retain its complete report.

## Nightly performance reports

`perf-nightly.yml` runs the full server component harness at 04:17 UTC and on
manual dispatch. It runs separately from `CI result` and does not open
`ci-main-red` issues or gate merges. Each report uses five warmups and thirty
measured repetitions. Candidates and diagnostics are retained as workflow artifacts.

The latest retained `perf-baseline` from a successful main run of this repository's
nightly workflow supplies the comparison; fork heads and other workflows are excluded. A missing
baseline, the dispatch's `reset-baseline` option, or incompatible fixture, harness,
hardware, OS, Git, browser or runtime metadata records a new baseline, with the
reason in the step summary. Incompatibility and missing artifacts both emit a workflow warning: no
performance comparison was made, and the previous baseline remains in the candidate
diagnostics artifact. Re-baselining does not qualify performance acceptance.
Compatible reports run `bun run perf:compare`;
regressions fail that workflow and appear in its summary. Feature-branch dispatches
can compare reports but cannot replace main's baseline. Every successful comparison
re-uploads the unchanged comparison baseline to refresh its 90-day artifact retention;
the anchor changes only on explicit reset, incompatibility, or a missing artifact.
Failed comparisons never promote candidates or refresh retention. If a long failure
streak expires the artifact, initialization explicitly warns that comparison was
skipped and the new baseline does not establish performance qualification. This report covers server
components; interactive qualification still requires the production-browser report.

The deleted-thread memory fixture can be run independently with
`F5_PERF_READ_MODEL=1 F5_PERF_DELETED_MEMORY_REPORT=/absolute/new-report.json bun run --cwd apps/server test:file --config vitest.performance.config.ts`.
It seeds 500 threads with 300 messages each, marks exactly 5% deleted, and takes
the median of three fresh-process hydrations. Use the same fixture on both pinned
source trees for a comparison; the ordinary all-live foundation fixture is unchanged.

Streaming reducer tests count structural timeline and row derivations independently
of content updates, verify one private thread-array copy per batch, and preserve
unchanged-row identity. Markdown state exposes parsed/validated character counts;
revision-based plain-paragraph and fenced-code tests verify linear growth without
a whole-prefix validation. These deterministic invariants do not establish the
production browser composer-latency gate.

The 2026-10-19 deleted-thread measurement used clean local source snapshots
`ebe292b4c85957f824621591224d30a0de23ce77` (foundation plus the matching harness)
and `1f405a6f0787efd92eb098ce8fbdd9fed222948d` (candidate). Both recorded the
same fixture and harness digests. The baseline retained 7,500 deleted-thread
messages; the candidate retained zero. Median retained heap was 51,804,104 versus
49,419,472 bytes; RSS was 304,611,328 versus 295,223,296 bytes. Reports are
`.performance/stability-{baseline,candidate}-deleted-memory-20261019-37.json`.
This is a three-process memory comparison, not a streaming or browser latency gate.

The next controlled full comparison used baseline
`ebe292b4c85957f824621591224d30a0de23ce77` and candidate
`4089fda501eda0adf0715c29616a0ded6b7e7099`, five warmups and thirty repetitions.
All latency and resource bounds passed, including terminal persistence and replay.
For uncoalesced Claude, median wall time changed from 7,569.44 to 6,369.71 ms,
median CPU from 6,494.09 to 5,876.95 ms, and SQL statements from 80,266 to 37,022.
However CPU p95 changed only from 7,870.84 to 7,535.64 ms, so the required 20%
CPU improvement failed. This candidate is not performance-qualified. Reports are
`.performance/stability-baseline-full-20261019-37.json` and
`.performance/stability-candidate-full-20261019-45.json`; do not substitute median
improvements for the documented p95 comparison gate.

The follow-up candidate `f4d4fd0fb30306452d1501819c572b868a1fb036` passes the
same full comparison against that baseline, including the 20% CPU p95 gate.
Uncoalesced Claude wall p95 was 6,184.10 ms and CPU p95 was 5,264.97 ms, versus
9,474.05 and 7,870.84 ms in the baseline. Median wall/CPU were 4,975.99/4,738.49 ms;
SQL statements were 29,034. All other latency and resource bounds passed.
The candidate report is `.performance/stability-candidate-full-20261019-53.json`.
This qualifies the guarded append, token-estimate and cursor updates in that
pinned source tree; subsequent lifecycle changes still need correctness checks.

The production-browser runner opts into report-only work counters before app startup:
row renders (a bounded 2,048-row sample), structural/content timeline derivations,
markdown parsed/validated characters, highlight jobs/bytes, and resource samples for
hydration buffers, retained messages, WebSocket listeners/timers and pending RPCs.
Before/after streaming snapshots remain in the browser artifact; numeric final
samples also enter the interactive report. Ordinary application sessions do not
collect these counters. This changes the harness digest; older reports remain valid
for their pinned comparison, but new comparisons require a matching harness baseline.

The clean-source production-browser smoke at
`3d89c5d5dbb488549372d94e99a564f17b397f72` recorded composer input p95
32.10 ms and streaming input p95 32.40 ms in
`.performance/stability-interactive-smoke-20261019-88.json` (one warmup, two
repetitions). It is a smoke result, not the full 50 ms qualification. The subsequent
full run failed its native process-table preflight with `spawn EPERM`, before the
soak started. Electron smoke also fails before opening the application on this host.

`F5_PERF_LIFECYCLE=1 bun run perf:interactive --smoke --output=.performance/lifecycle-smoke.json`
adds correctness checks after the measurements: the renderer reconnects, switches
threads and loads older history while streaming, then sends stop and approval controls while the production admission queue holds 1,024 ordinary
entries, then displays a provider crash with an editable preserved draft. The wire
provider is scripted; engine/reactor/writer saturation remains covered by their
separate tests. This optional phase does not replace full desktop qualification.
The lifecycle phase also verifies the captured reading row's offset after a prepend;
it waits for the virtual list's initial scroll to settle before generating wheel input.
Resource collection, the bounded row sample and history-anchor diagnostics are installed by the browser runner;
ordinary app sessions retain only the opt-in recording calls.

The follow-up clean-source lifecycle smoke at
`02ae8d4dfe8f758f0cf2a4c9f6537bd71bc07f84` passed all optional lifecycle
checks, including history prepend anchor preservation, thread switching during
streaming, reserved stop/approval admission and provider-crash draft recovery.
Composer input p95 was 32.4 ms both idle and streaming; the report is
`.performance/stability-lifecycle-smoke-20261020-155.json`, with detailed checks
in its `.browser.json` companion. It uses one warmup/two repetitions and does not
qualify the full 50 ms gate or memory soak. The rebuilt desktop smoke still fails
before opening a window; Playwright records `kill EPERM` during launch cleanup.

Client diagnostics reporting loads separately from stream subscription setup.
Router counters accumulate immediately; the reporter reads those accumulated values
when it starts. Disposal before its module loads creates no timers or listeners,
and a reporting-module failure does not prevent synchronization. With the subsequent
main changes included, the initial web JavaScript is 1,506,835 bytes, below the
unchanged 1,507,108-byte budget.

### Largest atomic compaction group

`apps/server/scripts/performance/compaction.ts` measures one file-backed group of
50,000 message events using the streaming fixture's maximum 64-character ASCII
delta (3,199,936 folded characters), with an ordinary writer admitted at the first rewrite.
Fixture reset is outside timing; five warmups precede thirty measured repetitions.
The normal server report includes this scenario and its writer/transaction maxima.
To run it alone from this revision:

```sh
F5_PERF_COMPACTION=1 F5_PERF_REPORT=/tmp/f5-compaction.json bun run --cwd apps/server test:file --config vitest.performance.config.ts
```

A clean-source macOS arm64 / Node 24.13.1 / SQLite 3.51.2 run on 2026-10-20 at
`e6fd4d92ae8eacb8c844725bc063c297ecd8d018` measured 355.33 ms median and
390.89 ms p95 total compaction wall time, 349.35 ms median CPU, 302.56 ms maximum
transaction duration and 298.14 ms maximum ordinary-writer wait. Percentiles use
`percentile95` from the existing report harness. This measures the event-count
ceiling; larger payloads can hold the writer longer. It is not a baseline
comparison or a Windows result.
Atomicity preserves replay equivalence; yielding between delete statements does
not release the writer lease. The 2,000-event target still packs complete small
groups, while a group up to the 50,000-event ceiling runs alone. Time budgets are
checked between groups. Large-group write stalls remain an explicit tradeoff;
observe production statement/event-loop data before starting the gated SQLite
worker track. A deterministic interruption test verifies the writer remains
blocked until rollback and then resumes.

## October diagnostics

General settings includes a Diagnostics card for OTLP trace/metric destinations
and collector headers. Restart F5 after editing these fields. Header values live
in the profile secret store, and reads expose only their names and redaction
markers. Explicit signal settings override `OTEL_EXPORTER_OTLP_*_ENDPOINT`, then
`OTEL_EXPORTER_OTLP_ENDPOINT` with `/v1/traces` or `/v1/metrics` appended. JSON
and protobuf HTTP protocols are supported. `OTEL_SDK_DISABLED=true` disables
observability, and `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none`
disable external export per signal. Export is inactive without a destination.

Trace export retains at most 4,096 records and 4 MiB, including an in-flight
batch. It sends one request at a time, bounds individual exports and requests,
and drops failed batches with backoff. Metrics snapshots export serially. The
local disk writer retains its independent queue and failure isolation. Collector
headers and URL query strings are omitted from public diagnostic source metadata.

`f5 trace summarize [--file <trace.ndjson>]` reads a trace incrementally and
prints the twenty slowest spans, failure and event-loop stall counts. Without a
file it resolves the selected profile's trace path. While local diagnostics is
enabled, `SIGUSR2` explicitly writes a heap snapshot under the profile's
`logs/observability` directory (except Windows). A heap snapshot pauses the
process and can contain application data; it is never taken automatically.
