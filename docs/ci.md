# Continuous integration

> Contributors: what CI runs and which checks to run locally.

`.github/workflows/ci.yml` runs on pull requests, every main push, nightly at
03:17 UTC, and manual dispatch. `CI result` is the single intended required check.
It waits for all validation jobs and rejects failed, cancelled, or missing verdicts;
intentionally skipped jobs pass. A policy test ensures new jobs join this gate,
matrices finish every shard, and all jobs have timeouts.

| Job                    | Scope                                | Work                                                                                                     | Timeout     |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------- |
| changes                | Every run                            | PR code-change and PR/push packaging filters                                                             | 5 min       |
| static                 | Every run                            | Formatting, lint, workflow lint, types, server boot, SDK/protocol audits, release smoke, tier/port drift | 15 min      |
| test                   | Every run                            | Seven workspace suites, server Git smoke, integration, extended Git matrix                               | 20 min      |
| server-unit            | Code changes                         | Two Linux unit shards, four workers each                                                                 | 15 min      |
| browser                | Code changes                         | Discovered browser tests in Chromium                                                                     | 15 min      |
| desktop                | Code changes                         | Sandboxed Electron smoke, profile lifecycle, marketing build                                             | 20 min      |
| windows-build          | Code changes                         | Strict Rust checks, workspace/Git/integration suites, desktop build and smoke, profiles                  | 30 min      |
| windows-server-unit    | Code changes                         | Two Windows unit shards, two workers each                                                                | 20 min      |
| macos-profiles         | Code changes                         | Swift, strict universal helper, selected profile tests                                                   | 15 min      |
| macos-suite            | Main, nightly, dispatch              | Strict native checks, all workspace/server suites, desktop and profile smoke                             | 60 min      |
| windows-release-checks | Packaging changes, nightly, dispatch | Two native Windows CLI archives and installed-upgrade rehearsal                                          | 45 / 90 min |
| CI result              | Every run                            | Aggregate verdict                                                                                        | 5 min       |
| main-status            | Current main only                    | Reconcile the `ci-main-red` issue                                                                        | 5 min       |

A docs-only PR (only Markdown or `docs/**`) skips the heavy jobs. Static checks
and workspace/Git/integration tests still run, including environment documentation
drift tests. Main pushes, nightly runs and dispatches always run heavy jobs.
Packaging paths additionally run the reusable Windows release checks, including
the installed-upgrade rehearsal. Docs-only changes skip these checks. The packaging
filter includes the paths introduced by PR #157 plus the shared CI/release wiring.
Packaging PRs have a 25-minute Windows wall-clock target; individual release-check
timeouts remain longer to retain diagnostics when packaging stalls.
The full macOS suite never runs on PRs. It feeds `CI result`, so release eligibility
waits for it after each merge (with a 60-minute job timeout). Hosted timing targets for
non-packaging PRs are at most 10 minutes on Linux and 12 minutes on Windows;
measure these on Actions before treating them as achieved. TypeScript is checked once
on Linux, whose case-sensitive filesystem catches import-casing errors. TypeScript
output is host-independent; Windows and macOS still run their native build and
runtime checks.

Only superseded PR runs are cancelled. Main commits use separate concurrency groups
by SHA, so a later merge cannot cancel an earlier commit's release-eligibility run.
For both tags and dry runs, release preflight requires the latest `ci.yml` push run
for the exact SHA, its latest attempt, and that attempt's `CI result` job all to have
completed successfully. It pages through the attempt's jobs and rechecks the latest
attempt before returning. It never waits or falls back to another SHA or older
successful attempt. Release eligibility includes macOS and, on packaging changes,
the Windows release checks.

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
download cache and Electron downloads, never `node_modules`, native or Turbo outputs.
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

Workflow lint uses the pinned actionlint Docker image with shellcheck enabled.
The image digest is maintained manually; Dependabot does not update it. The only
suppression is `SC2016` in release workflows for intentional single-quoted Node
template literals. The composite setup action is validated by executing it on the
hosted runners, since actionlint does not lint composite action definitions.

CLI archive builds deliberately switch to `CLI_NODE_VERSION` from
`scripts/build-cli-archive.ts` after installation; ordinary CI uses `.node-version`.
Windows ARM64 alone installs Bun 1.3.11, since Bun 1.3.9 lacks a native build there.

## Reports and diagnostics

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

## Distribution validation

`distribution-checks.yml` runs on main every Sunday at 03:17 UTC and on manual
dispatch. It reads the version/channel from the release manifests and calls the
same five-target CLI builder and Windows installed-upgrade rehearsal as release.
It also builds a Linux AppImage and runs `bun audit --json --audit-level=high`.
Findings at high/critical severity, scanner failures, and missing or malformed
JSON fail the audit job. Lower-severity findings remain visible in its sanitized
artifact. This workflow has no signing/publication secrets and does not build
unsigned macOS desktop packages.

Every archive runs the clean-PATH smoke and mandatory real-archive integration
with absolute input paths. Missing/unreadable inputs fail mandatory mode; ordinary
server suites may still skip when no archive is supplied. The report inventory
requires exactly one passed integration test and zero skipped tests. Archive smoke
and integration export bounded sanitized process diagnostics before removing their
fixtures. Artifacts and reports are retained for seven days; diagnostic names do
not match `cli-*`, which release assembly uses for payloads.

Scheduled failures create or comment on `[CI] Scheduled validation failing`, once
per run ID/attempt, without raw logs. The notifier does not close the issue on
recovery; manual runs do not notify. The maintainer reviews the issue and checks
schedule activity monthly because GitHub can disable schedules after 60 days
without repository activity.

The distribution rehearsal on [PR #177, run 39226735921](https://github.com/lopes-felipe/f5/actions/runs/39226735921)
passed clean-PATH smoke and mandatory integration on all five native archive targets,
with exactly one passed integration and zero skips in each uploaded JSON report.
Linux AppImage packaging and the unsigned Windows installed-upgrade rehearsal also
passed. Temporary PR rehearsal jobs were removed in an additive follow-up commit.
A protected release dry run and the main-only distribution dispatch remain maintainer
validation after merge; the dependency audit already reports high/critical findings.

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
Performance collection remains the manual workflow in `docs/performance.md`.
