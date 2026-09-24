# Upstream performance baseline

Phase 0d is being delivered in two PRs. The server component harness is available;
the browser/transport harness and complete baseline at
`290d261c9c9daa0c469b312d7f62dfd4ea9b9698` remain outstanding. This tooling does not
implement any upstream ports or certify Phase 0d as complete.

## Run server measurements

From the repository root, with dependencies installed and Node 24 available:

```sh
bun run perf:server --smoke
bun run perf:server --output=.performance/server-before.json
# After the relevant implementation changes, on the same machine/runtime:
bun run perf:server --output=.performance/server-after.json
bun run perf:compare .performance/server-before.json .performance/server-after.json
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

## Remaining Phase 0d work

The fixture specification also pins 10,000 chat messages with code, 50 attachment
references and ten 1 MiB tool outputs, plus ten streaming threads at 20 updates/s
each. Those sizes are tested, but this PR does not yet render or stream them.

Before Phase 2, add and run:

- Actual browser input-to-paint (p95 ≤ 100 ms), warm large-thread switch
  (p95 ≤ 500 ms), and unaffected startup/interaction paths.
- Ten streaming threads, native terminal/process polling, and the slow or
  disconnecting WebSocket client with a concurrent writer.
- Thirty-minute retained-memory runs, with final ten-minute growth ≤ 5% **and**
  ≤ 10 MiB; instrument internal replay, upload and terminal buffer peaks.
- The complete harness against the pinned original baseline and candidate with
  identical fixtures, recording browser and dependency versions. The baseline
  must use that commit's runtime code and dependencies, not current code with an
  old SHA label.

Reports carry an explicit `notMeasured` list. Passing the available server
comparison never certifies these outstanding measurements or permits relaxing a
Phase 2 acceptance threshold.
