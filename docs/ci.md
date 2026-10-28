# Continuous integration

> Contributors: what CI runs and which checks to run locally.

`.github/workflows/ci.yml` runs on pull requests, every main push, nightly at
03:17 UTC, and manual dispatch. `CI result` is the single intended required check.
It waits for all validation jobs and rejects failed, cancelled, or missing verdicts;
intentionally skipped jobs pass. A policy test ensures new jobs join this gate,
matrices finish every shard, and all jobs have timeouts.

| Job                 | Scope                   | Work                                                                                                     | Timeout |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| static              | Every run               | Formatting, lint, workflow lint, types, server boot, SDK/protocol audits, release smoke, tier/port drift | 15 min  |
| test                | Every run               | Seven workspace suites, server Git smoke, integration, extended Git matrix                               | 20 min  |
| server-unit         | Code changes            | Two Linux unit shards, four workers each                                                                 | 15 min  |
| browser             | Code changes            | Discovered browser tests in Chromium                                                                     | 15 min  |
| desktop             | Code changes            | Sandboxed Electron smoke, profile lifecycle, marketing build                                             | 20 min  |
| windows-build       | Code changes            | Strict Rust checks, workspace/Git/integration suites, desktop build and smoke, profiles                  | 30 min  |
| windows-server-unit | Code changes            | Three Windows unit shards, two workers each                                                              | 20 min  |
| macos-profiles      | Code changes            | Swift, strict universal helper, selected profile tests                                                   | 15 min  |
| macos-suite         | Main, nightly, dispatch | Strict native checks, all workspace/server suites, desktop and profile smoke                             | 60 min  |
| CI result           | Every run               | Aggregate verdict                                                                                        | 5 min   |
| main-status         | Current main only       | Reconcile the `ci-main-red` issue                                                                        | 5 min   |

A docs-only PR (only Markdown or `docs/**`) skips the heavy checks. Static checks
and workspace/Git/integration tests still run, including environment documentation
drift tests. Main pushes, nightly runs and dispatches always run heavy jobs.
The full macOS suite never runs on PRs. It feeds `CI result`, so release eligibility
waits for it after each merge (with a 60-minute job timeout). Hosted timing targets for
this optimization are at most six minutes per Windows unit shard with at most 20%
imbalance, and at most ten minutes per required job excluding queueing. These replace
the former 10-minute Linux/12-minute Windows targets and require hosted measurement.
TypeScript is checked once
on Linux, whose case-sensitive filesystem catches import-casing errors. TypeScript
output is host-independent; Windows and macOS still run their native build and
runtime checks.

Heavy jobs classify their own changes after checkout and before setup through
`.github/actions/changes`. There is no queued prerequisite filter job.
Docs-only heavy jobs succeed with their install/check steps skipped; a filter
failure fails the job. The full macOS suite retains its non-PR job condition.
This trades the serial dependency for runner allocation on docs-only PRs: every
heavy matrix job still checks out and filters on its normal hosted OS before
skipping setup and checks. `CI result` waits for these lightweight executions,
which can queue for macOS/Windows capacity and delay other PRs. Docs-only end-to-end
latency has not been measured; compare queue and execution time against the prior
topology before claiming a scheduling gain. The docs exclusions are unchanged.

Only superseded PR runs are cancelled. Main commits use separate concurrency groups
by SHA, so a later merge cannot cancel an earlier commit's release-eligibility run.
Windows release checks also cancel superseded runs by PR number; release callers
and manual rehearsals have independent concurrency groups and are never cancelled.
Release preflight currently checks the exact SHA's successful main push run. The
stricter explicit gate/attempt check and distribution workflow are deferred until
PR #157 merges; see the existing release documentation for the current behavior.

`main-status` ignores stale SHAs and deduplicates comments by run attempt. It has
no shared concurrency group: [GitHub's concurrency rules](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
allow a new pending notification to cancel a previous pending job, cancelling
that SHA's otherwise successful push run. Overlapping
notifications may rarely create duplicate issues; preserving each push verdict takes
priority over serializing issue updates.

A failed current main run creates or comments on `CI failing on main`, labelled
`ci-main-red`, once per run attempt. The notifier only selects an issue with that
exact title; other issues carrying the label are left alone. A successful current-main run closes it with
the green SHA and run URL. API errors do not change the CI verdict. Nightly
failures use the same issue. GitHub can disable schedules after 60 days without
repository activity; the maintainer checks schedule activity monthly.

## Reproducing failures

Use Node from `.node-version` and Bun from `packageManager` in `package.json`.
Install with `bun install --frozen-lockfile`. The shared setup action caches Bun's
download cache and Electron downloads separately, never `node_modules`, native or Turbo outputs.
Electron keys include its version, runner OS and architecture; changing an unrelated
dependency does not invalidate the Electron cache. Windows retains the separate Bun
package cache until the paired hosted setup benchmark establishes a faster default.
Rust caches are scoped to the Windows helper and fixture. The full macOS desktop
build steps request a 4 GiB Node heap for contract declaration generation, which
exceeds the ARM64 runtime's default 2 GiB limit. Turbo forwards `NODE_OPTIONS` to
build tasks. MSW worker regeneration
is explicit: its postinstall hook overwrites the worker with vendor bytes even when
the version already matches. A formatting difference alone can dirty the tracked
worker during installation. `scripts/msw-worker-install.test.ts` reproduces that behavior,
checks that the current install policy preserves the worker, and rejects a worker
version that differs from the installed MSW package. See `CONTRIBUTING.md` for the
regeneration command. Every test job checks for tracked changes and untracked
files at the end.

```sh
bun fmt
bun lint
bun typecheck
env -i PATH="$PATH" HOME="$HOME" bun run test:ci:workspaces
env -i PATH="$PATH" HOME="$HOME" bun run test:server:shard --shard=1/2
env -i PATH="$PATH" HOME="$HOME" bun run test:server:shard --shard=2/2
env -i PATH="$PATH" HOME="$HOME" bun run test:full
```

Always use `bun run test`, never `bun test`. `env -i` prevents F5 profile and provider
variables inherited from a running session from altering test fixtures. CI runs
server smoke and integration suites as independent steps. A failing suite does not
hide later suites; workspace Turbo execution also continues after failures.

Local `test:full` and the server's multi-stage scripts use
`scripts/run-test-stages.ts`: every stage runs, each exit code is summarized, and
any failed stage makes the overall command fail. The runner has a deliberate
first-stage failure regression check. The default workspace test command also uses
Turbo `--continue=always`.

Server Vitest configuration removes inherited `F5_PROFILE_`, `CLAUDE_CODE_`,
`GIT_CONFIG_KEY_` and `GIT_CONFIG_VALUE_` variables, plus `CLAUDE_CONFIG_DIR`,
`CODEX_HOME` and `GIT_CONFIG_COUNT`, before environment capture. Tests default to
`GIT_CONFIG_COUNT=0`; fixtures can explicitly opt into configuration they exercise.
Storage inspection now includes the bytes changed by persisting its own report
before publishing the result. A hermetic logical-byte test covers Windows
semantics without enabling suite-wide console output. Windows-hosted execution
and three consecutive hosted green runs remain acceptance requirements.

Local macOS verification on 2026-10-19 completed fifty consecutive iterations each
for the live-write backup snapshot, checkout refresh failure, stopped-session
projection timeout and all four hidden Bots redirect variants. The renderer
cold-import checks (`ChatMarkdown`, `FileViewPanel` and `MessagesTimeline.markdown`)
also passed fifty iterations with all eighteen assertions per iteration. Imports
now happen during file setup, outside the first rendering assertion's deadline;
no global retry or timeout increase was added. Git/workspace tests synchronize
with explicit completion barriers, and Bots tests subscribe to startup recovery.
A subsequent full run exposed `ENOTEMPTY` while removing a Git fixture whose
service-scoped upstream refresh was still writing. Fixture finalization now awaits
refreshes admitted for that checkout. The behind-count checkout case passed another
50/50 iterations without retries on 2026-10-19.
After syncing main on 2026-10-20, the OAuth callback-settings unit test also passed
50/50 iterations. It stubs and asserts the port probe instead of probing fixed port
3118; the separate real-socket ownership and callback-preflight tests remain enabled.
These local results do not establish hosted Windows behavior.

Workflow lint uses the pinned actionlint Docker image with shellcheck enabled.
The image digest is maintained manually; Dependabot does not update it. The only
suppression is `SC2016` in release workflows for intentional single-quoted Node
template literals. The composite setup action is validated by executing it on the
hosted runners, since actionlint does not lint composite action definitions.

## Reports and diagnostics

The WebSocket server and workspace-transition suites each have four behavior groups
and shared fixture factories, preserving test names, assertions, real-Git cases and
independent fixture cleanup. Linux keeps two shards with four workers; Windows keeps
three shards with two workers.

Duration scheduling is implemented but disabled in `apps/server/test-timings.json`.
The initial single-run estimates did not improve hosted Windows balance: run
40689999503 took 401/345/270 seconds for unit testing, versus 337/305/304 on main
run 40703866039. Those runs use different commits and are not controlled experiments.
Retain Vitest's default sharding and ordering until representative measurements are
available. Stored initial estimates are inactive, and an inventory check rejects
orphaned paths after renames/deletions; new files use the platform median when enabled.

Sharded CI reports include JSON in `durations.timings` with import, collection, setup and
execution costs. After at least three successful main push runs at distinct commits
containing these splits and matching the current test inventory, refresh explicitly:

```sh
bun scripts/refresh-ci-test-timings.ts <main-run-id> <main-run-id> <main-run-id>
```

The refresh uses each file's median across sources and enables longest-file-first
allocation to the lightest shard with stable path tie breaking. Each job's latest
execution supplies its reports, so partial reruns retain passed earlier jobs without
borrowing superseded results. Attempts are recorded per job. Skipped jobs, unknown
platform artifacts, missing metrics and incomplete/duplicate inventories fail before
writing. macOS remains unsharded and is not a timing-source dependency. Commit the
generated update separately and verify hosted balance before claiming the targets.
CI never modifies tracked scheduling data or caches test results.

Inspect hosted runs by queue time, total setup (including cache save), and job
execution, keeping rerun attempts separate:

```sh
node scripts/ci-run-timings.ts <run-id> [attempt]
```

The manual `CI setup benchmark` workflow runs three Windows samples of each
layout: historical combined cache, the shipped split Bun/Electron caches, and
Electron-only. At most two jobs run concurrently. Use a unique `cache-suffix`
for cold samples and repeat it on the same ref for warm samples. All nine jobs use
frozen installs and Electron verification. Each mode has independent keys so the
split layouts cannot warm one another within a dispatch. Runs sharing a suffix
are serialized. A third pending dispatch can replace an older pending run under
GitHub concurrency rules; do not queue multiple repetitions at once.

The summary includes cache compression/upload post steps, queue and total job
execution, even if a sample fails. Failed, missing, duplicate or unfinished samples
reject the comparison. Drop the Windows Bun cache only when Electron-only has a
lower median total setup time than both other layouts across three complete
samples; record cold and warm results before changing the default.

The new `bun-packages-` and `electron-` prefixes start cold on every OS.
Benchmark entries share the repository cache quota and can evict production caches.
After collecting cold and warm results, manually remove only entries whose keys
contain that benchmark's `benchmark-<cache-suffix>-` marker using GitHub's cache
UI. Confirm the ref and full keys first. This workflow has read-only permissions
and performs no automatic cache deletion.

Test jobs set `F5_CI_REPORT_DIR` to a job-specific runner-temp directory. Vitest
emits console output plus JSON and JUnit under encoded package/lifecycle names.
Direct server, shard, profile and browser invocations set `F5_CI_SUITE_ID` explicitly.
`ci-test-summary.ts` compares JSON reports against an expected inventory and fails
on missing, malformed, truncated, duplicate, unexpected, or unexecuted ordinary
suites, and on unfinished assertions or suites. Skipped live-provider tests remain visible in counts and skipped file details.
Reports upload even after failure for seven days with unique platform/job/attempt names.

At restructure review, both the former list and the glob covered 85 real browser
files. The larger count in the planning inventory included screenshot directories.
The glob automatically discovers future files; this change adds no existing test
coverage.

Browser tests discover `src/**/*.browser.{ts,tsx}` and keep failure
screenshots in `F5_CI_ARTIFACT_DIR`; local artifacts stay in the ignored
`apps/web/.playwright/` directory. Routine Playwright tracing is disabled because
recording every test slowed the suite beyond the job timeout. Browser execution
has an eight-minute process limit inside the fifteen-minute job, leaving time to
summarize and upload diagnostics. Uploads read a staging copy after execution ends,
so writers cannot remove files from underneath the uploader. Screenshot directories
under source are not globally ignored, allowing future golden baselines to be tracked.
Desktop/profile harnesses read the artifact
variable themselves and do not pass it into the app. They export bounded sanitized
process logs, fixture screenshots and lifecycle failure details before cleanup.
Local desktop smoke runs retain their temporary state and print its path for
debugging. CI exports diagnostics before attempting cleanup; locked temporary files
produce a cleanup warning without changing the smoke verdict.
Only these explicit files are uploaded. Profile directories, databases, provider
homes, auth files and cookies must never be uploaded.

## Maintainer rollout

PR #163 combines the Agent Bridge fix, workflow restructure, reports/diagnostics
and dependency maintenance. The original staged rollout was not followed. Review
corrections use focused additive commits, and all included CI jobs must pass on
hosted runners before merge. Muse auditing, the marketing build, Dependabot and
main-status reconciliation are part of the approved CI scope. Local checks do not
establish hosted macOS/Windows behavior, cache hits or wall-clock targets.

The full macOS rehearsal passed on PR #163 in
[run 39155081320](https://github.com/lopes-felipe/f5/actions/runs/39155081320):
6m38s for strict native checks, all workspace/server suites, desktop build/smoke
and profile lifecycle. The normal non-PR condition was restored in a follow-up
commit without rewriting history. That run also passed all 85 browser files and
854 tests; an earlier failed browser assertion successfully uploaded its screenshot.
These observations establish the rehearsal, not a guarantee of future timings.

Exercise the throwaway PR cases from
the implementation plan: docs-only, docs plus code, failing server assertion,
failing browser assertion, and native lock-file drift. Record cold/warm cache
behavior and Linux/Windows job timings. The permanent full macOS gate remains
limited to main, nightly and dispatch; an unverified gate is not ready to merge.

Feature merges pause while a `ci-main-red` issue is open.

After the workflow merges and main has three consecutive green push runs at distinct
SHAs, activate the Main ruleset manually: require PRs with no approval count, require
`CI result` from GitHub Actions with up-to-date disabled, block force pushes/deletion,
and allow Repository admin bypass for pull requests only. Agents do not edit these
settings. Enable Dependabot alerts/security updates, secret scanning with push
protection and CodeQL default setup for JavaScript/TypeScript and Actions separately;
these do not become required checks during stabilization.

Hosted verification must cover cold/warm cache installs, the macOS suite, docs-only
and code PR filters, independent execution after intentional failures, diagnostic
uploads and two successive non-cancelled main push runs. Temporary validation PRs
and branches are closed and deleted by the maintainer. Flake issues remain drafts
until explicitly approved; no blanket Vitest retries are configured.

## Certification limits

CI does not certify authenticated model turns, physical computer input, account
permissions, or signed installed-upgrade behavior beyond protected release rehearsals.
Performance collection includes the report-only nightly workflow and manual qualification described in `docs/performance.md`.

Release preflight requires a successful latest main push run for the tagged SHA.
Required job names and matrix variants come from `CI result` in the checked-out
workflow, with platform-specific skips derived from the release profile. Missing,
skipped or failed required jobs reject qualification; a failed latest attempt
cannot borrow an older successful run. Nightly performance is separate from that
release/merge gate.
