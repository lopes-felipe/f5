# Phase 0 validation

This report consolidates the prerequisite work. It does not implement Phases 1–14,
reclassify approved ports, or treat a planned workstream as delivered.

## Prerequisite audit

- **0a:** the secret publication race was reproduced and fixed, including collision,
  replacement and cleanup tests. The original full-suite failure and 200-run
  before/after evidence are retained in
  [the secret publication report](secret-publication-validation.md). The OAuth
  preflight race subsequently reproduced and was fixed with a deterministic test;
  see [the schema-5 report](upstream-ledger-v5-validation.md). That later full suite
  includes the exhaustive real-Git matrix. Hard-link support and crash-remnant
  limitations remain documented; this work does not claim secure erasure.
- **0b:** the September artifact accounts for all 1,836 commits. The schema-6
  follow-up preserves 2,332 unique records with explicit intervals and legacy
  coverage, replacing the old 500-entry window and separate manifest. There are
  no pending reviews; 875 interval commits remain planned work. Online provenance
  validation is mandatory in CI. The classification artifact and individual proof
  remain unchanged by this PR.
- **0c:** the exact-version WebSocket/HTTP gate and authenticated bootstrap are
  merged. Review fixes cover pre-welcome send/import behavior, attachment
  persistence before reload, repeated-reload protection and closing mismatched
  sockets. See [the protocol report](protocol-version-gate-validation.md). Existing
  limits remain global until providers actually differ; no new capability or
  protocol shape is introduced by this measurement-only change.
- **0d:** the harness now covers server components, the built browser, real socket
  backpressure, native terminal/process polling, concurrent SQLite writing and
  the complete retained-memory method. See [the reproduction guide](../performance.md).

## Revised duration and failed attempts

On 2026-09-24 the user shortened the retained-memory runs to **10 minutes**.
The harness measures growth over the final **5 minutes**, retaining the 5% and
10 MiB thresholds. Timing scenarios still use five warmups and thirty repetitions.
This is not a claim of thirty-minute stability. The original longer baseline run
was intentionally interrupted and is not counted as a completed measurement.

Two early Git fixture setup attempts failed with `could not parse HEAD`; diagnostic
and subsequent runs passed. No report was published from those failed attempts.
The cause was not established, so they are not described as fixed production bugs.

An initial attempt to prefill twenty native terminals with simultaneous large
output bursts exhausted the baseline Node heap. The final harness instead seeds
full histories in disposable persistence files, verifies production reads, then
runs ordinary sustained PTY output. This avoids adding a burst workload merely to
shorten fixture warmup. The failed burst is not part of the completed measurement.

The machine also had unrelated background work during acquisition. F5 benchmarks,
builds and verification were sequenced rather than run concurrently; no unrelated
process was stopped. Timing comparisons are measurements from this environment,
not evidence of an isolated clean-machine performance guarantee.

## Measurement results

Both revisions completed all seven server and five transport/browser timing
scenarios with five warmups and thirty repetitions, followed by eleven memory
samples over ten minutes. Both coverage checks pass. The two performance
comparisons correctly exit nonzero for the resource failures below; there are no
latency regressions exceeding both 10% and 20 ms. No targeted CPU improvement is
claimed by this tooling-only PR.

The baseline uses `290d261c9c9daa0c469b312d7f62dfd4ea9b9698` with its own frozen
dependencies and no tracked production-source modifications. The candidate runtime
is `102177a274e81c78e7903549d3fee62594c3eb6b`, with this PR's harness overlaid. The
harness and documentation are the only uncommitted changes affecting the report's
dirty flag; no production runtime source is changed.

Environment: Apple M4 Pro, 14 cores, 48 GiB RAM, Darwin 27.0.0 arm64,
Node 26.9.0, Bun 1.3.11 and Chromium 145.0.7632.6. Reports contain installed
dependency versions, browser configuration, raw samples and source metadata.

| Wall-clock p95 (ms)                    | Baseline | Candidate |
| -------------------------------------- | -------: | --------: |
| `terminal.ingest-20`                   |    58.39 |     58.60 |
| `terminal.persist-reconnect-20`        |    16.87 |     14.55 |
| `replay.20000`                         |   381.77 |    363.61 |
| `upload.decode-persist-release-8MiB`   |    33.49 |     23.42 |
| `replay.slow-reader-with-writer`       |   551.15 |    425.92 |
| `replay.cancel-after-1000-with-writer` |    23.80 |     25.36 |
| `git.status-large-nested-submodules`   |   465.60 |    163.44 |
| `transport.slow-disconnecting-client`  |     7.30 |      7.16 |
| `browser.startup-small`                |   138.80 |    134.90 |
| `browser.warm-switch-large`            |   182.30 |    179.80 |
| `browser.composer-input`               |    18.10 |     16.90 |
| `browser.composer-input-streaming`     |    15.80 |     17.10 |

| Failed bound                            |    Baseline |   Candidate |       Limit |
| --------------------------------------- | ----------: | ----------: | ----------: |
| Long-line terminal history              | 4,489,216 B | 4,489,216 B | 4,194,304 B |
| Replay page events                      |         500 |         500 |         200 |
| Slow-client pending frames              |       4,148 |       4,148 |       2,000 |
| Browser heap growth, final five minutes |      11.15% |       9.45% |          5% |

The browser's absolute retained growth remains below 10 MiB in both runs, but the
ratio fails. Server and combined retained-growth gates pass. The candidate's
composer p95 is 16.9 ms idle and 17.1 ms under streaming; warm switching is
179.8 ms, meeting the absolute 100/500 ms gates. Replay page bytes, decoded upload
buffers, normal native terminal histories, push-queue depth and writer errors
also meet their limits.

Baseline: peak sampled server heap 1754.9 MiB; 120,400 domain events offered and 120,400 sent; 20.0023 updates/second/thread; 80,079 concurrent SQLite writes with zero failures. All twenty native terminals remained running.

Candidate: peak sampled server heap 305.8 MiB; 120,400 domain events offered and 120,400 sent; 20.0026 updates/second/thread; 87,575 concurrent SQLite writes with zero failures. All twenty native terminals remained running.

The transient server-heap spike remains an observation requiring investigation;
an ending retained-growth pass is not evidence that transient memory use is small.
Likewise, these failures are a baseline for Phase 2, not a claim of performance
acceptance. No limit was relaxed to make a comparison pass.

Raw reports remain untracked in `.performance/`, named
`phase0-final-{baseline,candidate}-{server,interactive}.json`.
The original interrupted and failed runs are not substituted for these completed
runs. Both revisions have identical fixture, harness and lockfile digests:

- `fixtureDigest`: `1d46827a736c74b201fd7714e0919411a512703f3913e889dcab5d8dd69de355`.
- `harnessDigest`: `07d8d76a959352710d2a55b41c7984568729a0a4a13e1c3a99e9e78fca116fc1`.
- `dependencyLockDigest`: `a46b44126a062f0dbab33a975a65b004691d43d5ce62368bed347dbcdc6a26b4`.

## Verification

- `bun fmt`, `bun lint` (eight existing warnings), `bun typecheck` and `git diff --check`: passed.
- `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=2 bun run test:full`: passed all seven workspace tasks and all 107 extended Git tests. Workspace coverage includes 2,397 server unit, 13 server integration, 8 Git smoke, 1,626 web unit and 105 tooling tests.
- `bun run --cwd apps/web test:browser`: all 429 tests passed.
- `bun run test:desktop-smoke`: passed.
- `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check`: passed, with 2,332 records, 1,836 interval commits, 496 legacy commits, zero pending reviews and 875 planned commits.
- Ten focused performance fixture, gate, coverage and writer-lifecycle tests: passed.
- Both full measurement acquisitions and both coverage validations: passed. Performance comparisons reject the four distinct resource violations above, as intended.

The first full-suite attempt passed the workspace tasks but two existing fork-PR
worktree tests exceeded their 15-second timeout in the concurrent Git matrix.
Both passed in isolation; the entire suite then passed with one server test worker.
No test timeout, assertion or production Git behavior was changed. This first
failure is retained as validation history rather than counted as a successful run.

Checks ran on macOS arm64. No Linux or Windows packaged-run result is claimed.
Phase 0 prerequisite implementation and the revised measurement coverage are
complete. Performance acceptance remains failed on the recorded bounds; Phases
1–14, including the fixes for those bounds, remain unfinished.
