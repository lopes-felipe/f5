# Phase 1b: checkpoint capture reliability

This follows merged PR #35 at `906afb0185`. It implements five additional upstream records: `8130a9f13`, `869347bc2`, `1455cb5c3`, `67993623a`, and `c843c1929`. Together with the first batch, 11 of the 33 Phase 1b records are delivered; 22 remain unfinished. This PR does not change the pinned coverage or the original review artifact.

## Behavior

Checkpoint Git writes use `core.fsync=objects,reference` and `core.fsyncMethod=fsync` when staging blobs, writing trees/commits and publishing the ref. Capture commands retry only recognizable lock collisions and file-disappearance races, with three retries after the initial attempt and exponential delays starting at 75 ms. Permission errors and unrelated failures are not retried. The same private index is used throughout an attempt and removed on success or failure.

An empty embedded repository no longer prevents capture of the surrounding workspace. Only Git's specific “does not have a commit checked out” staging failure triggers recovery. Discovery uses a NUL-delimited list, rejects more than 64 candidate directories, clears inherited repository/index bindings for child probes, and excludes only repositories confirmed to lack a HEAD commit. Literal pathspecs preserve unusual names. The entire discovery/probe/restage operation has a five-second deadline; output collection is bounded at 8 MiB. Failure never publishes a checkpoint ref. Neither the user's index nor the nested files are changed.

A missing or failed baseline lookup no longer prevents saving the completion checkpoint. Without a baseline, the new checkpoint is retained with an empty file summary; no baseline is invented and no diff is requested. This also permits subsequent captures after Git is initialized during a turn. Genuine diff failures still use the existing warning/activity path.

No database migrations, settings defaults, capabilities or wire schemas change. No protocol bump is needed. Capture timing, nested-workspace detection, private-index reuse and sparse-checkout optimization remain separate unfinished work; no Phase 2 performance improvement is claimed.

## Regression coverage

- Transient lock and stat failures recover; permanent errors fail immediately; retry exhaustion stays bounded and never publishes a ref.
- All object/ref-producing commands use durable-write configuration.
- Empty-repository discovery rejects excessive candidates, output failure and a stalled scan; temporary indexes are cleaned up.
- Real Git captures parent repositories with and without a HEAD commit, including multiple empty nested repositories, literal-special-character names and a committed nested repository. Captured files are correct and the user's index is byte-identical.
- Completion capture succeeds with an absent baseline, a failing baseline lookup, or Git becoming available after turn start. No nonexistent baseline diff is requested.

## Validation

Validated on macOS with Node 26.9.0 and Bun 1.3.11. Formatting, lint (zero errors; nine existing warnings), typecheck and `F5_TEST_MAX_WORKERS=1 VITEST_MAX_WORKERS=2 bun run test:full` passed. The full run includes 2,425 server unit tests, 8 Git smoke tests, 15 server integration tests and 125 real-Git tests, plus the other workspace suites. Existing opt-in/skipped tests remain skipped. Worker limits reduce contention; production deadlines and test assertions were not relaxed.

The online upstream check and scripts suite run again after recording the implementation commit. No browser or desktop behavior changes in this batch.
