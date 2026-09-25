# Phase 2: terminal history and polling

Based on merged main `08f7a61ad1`. This PR implements the terminal subset of Phase 2,
referencing upstream `3bbbc1d9f`, `cf9729d5e`, and `80991402d`. Streaming resync,
projection reads, browser rendering and observability remain separate Phase 2 work.

## Behavior

- Retained history keeps at most 5,000 lines and 4 MiB of UTF-8 text. Whole old
  lines are evicted first; an oversized remaining line is truncated at a code-point
  boundary. Live output is still delivered in full.
- A deque tracks bytes and newlines incrementally. Snapshots cache joined text and reuse that string as the deque backing storage;
  persistence materializes it at the coalesced write, rather than on every PTY
  callback. A slow write retains one pending history reference instead of queuing
  a new full-history string every debounce interval.
- Split JS surrogate pairs are joined before byte accounting. Existing PTY UTF-8
  stream decoding is retained. Closing a stream flushes an incomplete pair before
  the next process can append. ANSI and CRLF output are preserved.
- Restoring current or legacy logs reads at most the byte ceiling plus four bytes
  of UTF-8 overlap, in 64 KiB reads with a persistent decoder. Short reads are
  supported and the handle closes before any capped-history rewrite.
- Process polling reads one bounded process table every two seconds, shared by
  all running terminals. Failed or partial reads retain the last activity state.
  A session that closes or restarts while the read is in flight is not updated by
  the old snapshot.

There are no new settings, capabilities, wire shapes or protocol bump. f5's 4 MiB
limit is intentional; upstream uses 8 MiB.

## Measurement method

The original Phase 0 baseline and its known failures remain in
[the Phase 0 report](phase-zero-validation.md). This PR also measures the merged
pre-change runtime and candidate on the same machine. Each acquisition uses five
warmups and thirty repetitions, plus the agreed ten-minute interactive soak and
final five-minute retained-memory window. Reports remain ignored artifacts.

The first browser acquisition failed before measurement because the harness sent
protocol 1 to the version-4 build. The fixture now accepts the tested runtime's
protocol version, falling back to 1 for the original pre-protocol baseline. Both
sides of the comparison use this same harness correction. No resource threshold
or fixture workload was changed.

Implementation moved to an isolated worktree after unrelated changes appeared in
the original checkout. The pre-change runtime and renderer were already loaded;
none of those unrelated changes are included in this PR. Dependency installation
for the isolated checkout took about eleven seconds during the pre-change soak;
this is recorded rather than claiming complete machine isolation. No test suite
or build ran during the soak.

## Validation

- `bun fmt`, `bun lint` (nine existing warnings), `bun typecheck`, and `git diff --check`: passed.
- `bun run test:full`: passed, including 2,606 server unit tests, eight Git smoke tests, 16 integration tests and 131 exhaustive real-Git tests. Existing optional live tests remain skipped.
- 46 focused terminal tests pass, covering randomized chunk boundaries, split surrogate pairs, UTF-8 short reads, ANSI/CRLF, a huge line, persistence/reconnect, blocked-write coalescing, one probe per cycle, failed probes and restart during a probe.
- The protocol-aware fixture regression passes. macOS desktop smoke passes.
- Online ledger validation passes; the three terminal records have implementation proof. Coverage remains 2,332 records, with zero pending reviews, 190 ported and 719 planned.

Final candidate runtime: `b2a95bac47`; its report's dirty state comes from documentation work. Server measurement p95 values:

| Scenario                                | Before wall (ms) | After wall (ms) | Before CPU (ms) | After CPU (ms) |
| --------------------------------------- | ---------------: | --------------: | --------------: | -------------: |
| Terminal ingestion, 20 sessions         |            50.48 |            1.76 |           50.81 |           4.80 |
| Terminal persist/reconnect, 20 sessions |            14.07 |           17.92 |           29.47 |          48.83 |

Terminal ingestion improves CPU p95 by **90.6%**, exceeding the 20% target. The long-line retained-history check improves from 4,489,216 to **4,194,304 bytes**, meeting the 4 MiB bound. No measured server scenario regresses beyond both 10% and 20 ms. The server comparison remains nonzero only for the previously recorded `replay.pageEvents` bound (500 versus 200), which this terminal PR does not change.

The first candidate soak was deliberately interrupted after observing roughly 98 MiB more retained server heap with twenty materialized histories. It is not counted as a completed measurement. The cause was duplicate backing strings: the fragment deque and joined snapshot cache each retained the full content. Materializing a snapshot now replaces those fragments with one descriptor referencing the same joined string. Subsequent output appends separate bounded fragments; eviction still advances the head offset. A regression exercises repeated snapshotting, append and eviction. The final run starts at 163,170,328 bytes of server heap versus 163,127,792 before, removing the observed duplicate-copy cost. Both final reports pass coverage validation: five warmups, thirty repetitions, and all eleven samples over ten minutes. Browser p95 is 17.0 ms for idle composer input, 16.0 ms while streaming, and 180.7 ms for a warm large-thread switch. No latency comparison exceeds both regression thresholds.

Final five-minute server growth is **170,536 bytes (0.10%)**, below both 10 MiB and 5%. Peak sampled server heap is 163,170,328 bytes versus 163,127,792 before. Combined growth is 5,354,456 bytes (2.50%), also passing. Parent server CPU across the ten-minute soak drops from 367.2 to 195.7 seconds (**46.7%**); this excludes child-process CPU and is a whole-workload observation, not isolated process-poller CPU.

Overall Phase 2 performance acceptance is **not complete**. The unchanged replay and transport paths still exceed 200 events per page (actual 500) and 2,000 pending frames (actual 4,148). Browser retained growth is 10.04% versus 8.00% before, exceeding the 5% gate in both runs; its absolute growth remains under 10 MiB. Both comparison commands correctly remain nonzero for these outstanding bounds. No thresholds were relaxed and these failures are not waived by marking the terminal ports implemented.

Completed raw reports remain untracked under `.performance/phase2-terminal-{before-v2,final}-{server,interactive}.json`. They have matching fixture, harness and dependency-lock digests:

- Fixture: `2e125d926c64891e6629d3bda026806b7efdf642f415c8e7cc6b41781f91638d`.
- Harness: `13210e07d51614a661abb477b6b0a5fbdfa19709dde70af5b6a8a3d6072d780d`.
- Lockfile: `a46b44126a062f0dbab33a975a65b004691d43d5ce62368bed347dbcdc6a26b4`.

Measurements and desktop smoke ran on macOS arm64 (Apple M4 Pro, Node 26.9.0, Bun 1.3.11). Windows process-table behavior is fixture-tested; no native Linux/Windows packaged smoke result is claimed.

A full-suite rerun after the storage-sharing adjustment failed once while connecting
the invalid-bootstrap-attachment WebSocket test, before its assertion path. That
test passed in isolation. No timeout, assertion or production WebSocket behavior
was changed; the complete suite then passed, including all 131 exhaustive Git tests.

The targeted Unicode/history check also passes under Bun; the full suite uses Node.

## PR review follow-up

Process-table failures now log once per failure episode and once on recovery.
Activity retains its last known value until a successful probe: a failed read is
not evidence that a child exited. Polling continues so recovery needs no restart.
POSIX probing falls back to a header-bearing `ps -A -o pid,ppid` table if the preferred
syntax fails. Missing tools, oversized tables, or failures of both forms still
retain state. The fallback is fixture-tested; no native BusyBox run is claimed.

Tests now cover repeated failures/recovery and close/reopen with the same PID,
in addition to restart with a different PID. Tests and the server benchmark use
the production shared-reader path; the obsolete per-terminal test hook is removed.
The materializing snapshot method documents its storage compaction.

The persist/reconnect CPU p95 increase (29.47 to 48.83 ms) is accepted for this
slice under the existing gate, with only 0.64 ms of CPU margin. Its wall increase
is 3.85 ms. The measurement does not isolate the cause, so neither decoding nor
snapshot joining is claimed as proven responsible. Cached reads do not rejoin
unchanged history. Bounded file reads and Unicode decoding remain necessary to
avoid loading arbitrarily large logs. This is a narrow pass, not evidence of a
persist/reconnect performance improvement. Historical benchmark results above
precede this review follow-up; the harness injection change alters its digest.

Review follow-up checks: formatting, lint (nine existing warnings), typecheck,
55 focused terminal tests, the complete workspace suite plus 131 exhaustive Git
tests, and online ledger validation pass. A direct server-unit invocation inherited
the profile-isolation environment and failed 11 provider mock assertions about CLI
arguments; the normal repository test runner passed those tests. No provider code
or assertions were changed.
