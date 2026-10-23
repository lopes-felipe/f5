# October catch-up review response

The October implementation and review fixes live on `fix/upstream-october-review`
in `../f5-upstream-october-review`. The latest integration retains origin/main
`83e054f412` additively, including all 23 commits since the preceding main merge.
The original shared checkout and user work remain intact. Review the catch-up
against that main baseline with:

```sh
git diff 83e054f412
```

Protocol 36 and migration 127 extend main's released baseline. The recommendation
to rebase conflicts with AGENTS.md's prohibition on history rewriting; integration
preserves both histories instead. The original October branch and subsequent
implementation commits remain reachable. The full plan and mandatory cut line
are still unfinished; the continuation entries below record implementation and
validation without promoting deferred release obligations.

Additional regressions exercise auto-pull and completed worktree setup against
real checkouts with over 1 MB of expanded ignored dependency paths. They share
the same fixture as the cleanup regression. Audit previews now include the total
path count as well as their existing 32-entry/4 KiB bound. The cancellation result
also carries the common ignored-path result field, retaining the newer cleanup
checks without breaking audit consumers.

The findings are accepted. The only procedural departure is preserving history
instead of rebasing. This patch does not claim the full catch-up or its mandatory
cut line is complete; the unresolved obligations below still apply.

## Continued implementation after the full-plan request

The integrated baseline is committed as `aaff303849`. The shared checkout was
subsequently saved by the user as `f46c26cd2c` and switched to main; continuation
now uses the isolated `f5-upstream-october-review` worktree. Subsequent implementation
adds the following behavior, with delivery decisions still requiring per-SHA proof:

- Legacy global and per-instance OpenCode passwords move to `ServerSecretStore`.
  Removed instances also remove their stored passwords. An explicit replacement
  repairs a missing secret; unrelated changes still fail closed.
  Migration and ordinary writes share rollback, preserve symlinks, and fail closed
  when a stored reference cannot be read. Collector headers use the same path and
  are removed from client reads. Failed migration preserves the original document.
- OTLP traces and metrics use the installed Effect JSON/protobuf serializers.
  Endpoint/header precedence, signal kill switches and resource attributes are
  resolved centrally. The trace exporter bounds retained bytes and records,
  owns one HTTP request, rejects redirects and aborts on shutdown. Metrics export
  serially with bounded bodies and request deadlines. Unavailable log directories
  do not prevent server work. The General settings Diagnostics card exposes
  collector URLs, secret header editing and credential-free source information.
- Event-loop stalls become independent duration-bearing spans with a 128-entry
  recent history. SQLite spans identify connection role and semaphore wait time.
  Standalone queries now reserve the connection until their operation scope closes;
  a failing-before test shows a transaction entering a suspended statement before
  this change, and verifies both serialization and the visible query result. Explicit SIGUSR2
  requests write heap snapshots, and `f5 trace summarize --file ...` streams a
  bounded trace reader and reports slow spans, failures and stalls.
- Captured GitHub API requests use bounded HTTP reads instead of `gh api`.
  Conditional caching, scheduling, credential scope and generation checks remain.
  A rejected token refreshes once, and retries cannot change the account. A
  failing-before race test also proves that a retry uses the exact token whose
  identity was verified, even if token resolution changes during refresh. The
  legacy CLI token fallback has tested five-minute/ten-second positive/negative TTLs.
  PR listing/viewing/creation, reviews, comments, ready state, reviewer changes,
  guarded merge/branch update, repository metadata, teams and search now use the
  captured HTTP path. PR Hub diff reads request bounded text through the same
  boundary. Concurrent head lookups batch up to 50 per repository/account/priority,
  and the five-second shared remote-routing cache avoids Git work for repeated
  reads. Explicit manual sync now waits for read admission after rate-limit reset,
  releases scheduler queue capacity while sleeping, and cancels on account changes.
  It never replays mutations or an already-admitted failing operation. Manual sync
  following an in-flight background sync retains its interactive scheduling scope.
  The remaining 15g verify-first scenarios and merge-read policy are still obligations.
- Desktop login-shell hydration imports missing CA trust variables without
  replacing inherited values. A packaged boot entry enables the V8 compile cache
  before main and preloads it inside the isolated backend. Development and
  AppImage paths retain their existing policy; Node's opt-out is respected.
  Settings → About installs explicit `f5`/`t3` symlinks to a launcher using the
  bundled runtime. It preserves foreign and dangling destinations, serializes
  installs, falls back without privilege escalation and refuses PATH shadowing.
- Provider initialization diagnostics and unavailable snapshots now contain fixed
  failure categories instead of schema payloads or raw driver errors. Two
  failing-before tests reproduce credential leaks through both paths.
- Panel tabs can be dragged, searched with Mod+T and reopened with Mod+Shift+T.
  All explicit close actions share a bounded 20-tab history per thread, retaining
  file positions. Removing a thread clears it; hiding a panel adds no history.
  Conversation width also offers Full while preserving existing preferences.
  Unbound effort-up/down commands use reported model levels and the existing
  Codex fallback policy, retain other traits and ignore repeated keydown events.
  A full-app Chromium case verifies the custom bindings without sending a turn.
- Settled Mermaid fences load 11.17.x only when visible, serialize global renderer
  configuration, bound the pending queue/source/output/cache, and follow light/dark
  themes. SVGs display as images rather than application DOM. Source toggling and
  failure fallback stay in place. Shell fences use the existing terminal command
  runner on an explicit click, with a fresh terminal in the thread workspace.
  Streaming/unfinished fences, non-shell languages and invisible controls have no
  run action; external-bot rendering retains its restricted policy.

Focused fake-collector, secret persistence/recovery, HTTP credential, browser
settings, real child-process cache, CLI and desktop isolation checks cover these
changes. The Node-built CLI successfully summarized a fixture without starting
the server. Both server and desktop builds succeed. Later validation results
supersede the earlier handoff below.

The full plan is not delivered yet. Settlement, thread HTML tools/MCP apps,
PR watches/guides and remaining PR UX, project provider/custom ACP/Pi,
scratch projects/prompt links, timeline/panel/usage/native history changes,
desktop passkeys, full verify-first triage and remaining performance
comparisons are still required. No unfinished workstream has been promoted.

## Current validation (2026-10-19)

- `bun fmt`, `bun lint`, `bun typecheck` (all eight packages),
  `F5_REQUIRE_UPSTREAM=1 bun run upstream-ports:check` and whitespace checks pass.
- Five focused Git/cleanup suites pass 65 tests, including both new consumer
  regressions. The final audit-summary change passes all 24 cleanup tests again.
- The exhaustive real-Git matrix passes 162 tests; Git smoke passes eight;
  server integration passes 25, with 18 existing opt-in skips.
- The earlier continuation server unit run passes 4,787 tests and fails three launcher process-identity
  cases because this host rejects `/bin/ps` with `EPERM` (12 existing skips).
- Desktop unit tests pass all 567 cases after the installer/cache changes. The Chromium cross-frame snapshot smoke
  passes. Native Electron 40.6.0 aborts with `SIGABRT` before a result, so native
  integration remains unverified.
- A fresh 40 MiB WAL measurement passes five warmups and thirty measured
  repetitions. The largest event-loop p99 is **1.446911 ms**, below 50 ms. The
  [raw report](./upstream-october-checkpoint-measurement.json) retains every
  sample, runtime/hardware details and fixture/harness/lockfile digests. It
  explicitly records the uncommitted source (`sourceDirty: true`), and makes no
  comparative CPU or whole-application performance claim.
- `bun run test:full` was executed and fails the same two scripts migration
  recovery identity cases: 330 tests pass, two fail. It stops before the
  exhaustive matrix; that matrix was run independently above. Recovery remains
  conservative when process identity cannot be verified. No assertion, identity
  protection or required gate was skipped or weakened.

The full gate is failed. Verify-first triage and the remaining security/native
verification obligations are unfinished. These results do not establish the
mandatory catch-up cut line.

The subsequent HTTP/SQL/panel continuation passes 589 Git/PR Hub/source-control
checks, 18 focused SQLite checks, 72 panel/shortcut checks, 138 appearance/settings
checks, nine installer/About browser checks and four panel browser checks. The
updated exhaustive Git matrix passes all 162 cases. Its fake adapter now honors
`state: "all"` and normalizes API states, preserving the existing closed/merged/
fork/open-preference assertions. The real desktop launcher starts Electron in
Node mode and successfully prints the bundled server's `--help`. Full native GUI
snapshot verification remains separate and unverified.

The complete server run after the SQL reservation correction passes 4,808 tests
and fails six (12 existing skips). Three are the launcher identity checks; three
are workflow-storage assertions affected by concurrent workflow-archive edits
in this checkout. Those edits are preserved and outside this continuation.
Subsequent focused privacy/settings/registry checks pass 38 cases, and the latest
HTTP/token race suite passes 66. Chromium tab dragging passes with no unhandled
errors, as do the searchable tab menu and panel boundary checks.

A fresh checkpoint measurement after the SQL reservation correction again runs
five warmups and thirty measured repetitions. Maximum event-loop p99 is
**3.219455 ms**, below 50 ms. The [new raw report](./upstream-october-checkpoint-postscope-measurement.json)
retains source-dirty, runtime, hardware and digest metadata. Earlier reports are
preserved; none is a comparative CPU or whole-application performance claim.

## Earlier implementation and review evidence

The empty supplied patch did not contain this branch. Author A's statement that
there was no implementation applies to that patch, rather than this worktree.
The completion gap is valid: the full catch-up and its mandatory cut line are
still incomplete. Coverage accounting is not delivery credit.

`4d4e868562` also merges the subsequent main head `9539f4b18b`; no main commits
are missing at this verification point. It includes main's regression for a
directory rename with unchanged timestamps. Its directory-entry signature is
retained. The merged watcher suite passes all 17 cases in isolation, but the
complete server run still misses a directory notification (4,679 passed, four
failed, including the three launcher identity cases). A deterministic silent
watcher regression independently fails before reconciliation. One shared timer
now rechecks registered paths at the existing two-second poll interval, skipping
failed/missing watches that already poll, in-flight checks and pending debounces.
It reads signatures without file contents and stops when the registry is empty.
The new regression also checks later renames and release ownership.

## Changes following review

| Finding                                                  | Resolution and evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ignored dependency paths overflow the status buffer      | `a54bdf0bab` separates status from two ignored scans. Ordinary ignored directories remain collapsed. A bounded pathspec scan finds `.env` and `.env.*` segments inside ignored trees. Both scans propagate truncation and errors block removal. A real fixture produces over 1 MiB of ignored paths, retains its nested credential, then becomes removable after that credential is removed.                 |
| Ignored-path audit strings are unbounded                 | Path previews are limited to 32 entries and 4 KiB of UTF-8 labels, with an omission count and escaped control characters. A Unicode regression checks the byte bound.                                                                                                                                                                                                                                        |
| Manual removal inherited the automatic cleanup exception | Automatic cleanup now uses the build-output policy; the environment-only policy was withdrawn after review. Manual, maintenance, legacy and rollback removal retain the original dependency-directory exception. Real tests preserve a database, `.envrc` and a private key through both the orchestration gate and direct GitCore removal.                                                                  |
| Branch is behind main                                    | `12fd563d5d` merges `97df84626a`, preserving both histories. Rebase was not used because AGENTS.md prohibits history rewriting. Workspace transitions and recovery fingerprints are retained. Protocol 26 follows main's released 25; migration 120 is next.                                                                                                                                                 |
| Writer read transactions reserve the write lock          | `66e146d8b8` adds `withReadTransaction`, which reserves the existing connection and starts deferred BEGIN. Nested read snapshots remain consistent while another connection writes. Write transactions use BEGIN IMMEDIATE in Node and Bun.                                                                                                                                                                  |
| Missing separate-process BEGIN IMMEDIATE coverage        | Four integration cases exercise ordinary writes and read-then-write transactions in separate Node and Bun processes. The transaction's first read observes the committed competing write, rather than an earlier snapshot.                                                                                                                                                                                   |
| Missing exclusive-lock preparation recovery              | The same prepared query succeeds on positional and row paths immediately after an exclusive database lock is released. The production 5,000 ms busy timeout remains independently tested.                                                                                                                                                                                                                    |
| Missing 40 MiB checkpoint latency coverage               | The dedicated performance command uses five warmups and thirty measured repetitions with runtime/hardware/fixture metadata. The initial largest event-loop p99 was 1.715 ms. After the idle-checkpoint correction, a fresh five-warmup/thirty-repetition run measured a maximum of 1.750015 ms, below the 50 ms requirement. This is not a comparative CPU or whole-suite performance claim.                 |
| Checkpoint contention gauge has false positives          | The worker reports contention only after an incomplete PASSIVE attempt, not merely an uncheckpointed NOOP result. Its description includes reader or writer contention. A deterministic worker-source test covers backlog, incomplete checkpoint and recovery.                                                                                                                                               |
| Short passwords corrupt snapshot metadata                | `414eb21d48` uses word boundaries for credentials shorter than four characters. Existing field names and unrelated words remain readable; exact credentials remain masked. Serialized variants and a bounded matcher count are covered.                                                                                                                                                                      |
| Worktree add lacks an option terminator                  | `a54bdf0bab` adds `--` before the path and base ref. Unit argument checks and the real-Git matrix pass.                                                                                                                                                                                                                                                                                                      |
| Missing user MCP credential argument test                | `414eb21d48` also fixes the underlying SDK behavior: header/env-bearing configs travel over its existing control channel, before any prompt is admitted. The real installed SDK transport test inspects actual process arguments and the control request. Failure, cancellation and timeout close the owned query without exposing configuration errors. Every startup and recovery creation uses this path. |
| Trace integration test assumes a 25 ms filesystem write  | The test now waits on the real sink's flush barrier, preserving its span-name and attribute assertions. All 52 engine/observability cases pass together.                                                                                                                                                                                                                                                     |
| Unresolved yaml imports                                  | The scripts workspace already declares yaml. Frozen dependency installation resolves the imports; all eight typecheck packages pass. No manifest workaround was needed.                                                                                                                                                                                                                                      |

Settings/logging verification now includes three failing-before reproductions for
malformed credential values in disk decode logs and disk/memory normalization
errors. The fix reports only known top-level settings fields, bounds traversal,
and never formats raw values or dynamic record keys. The write guard and original
invalid file remain intact. A second failing-before reproduction found development
URL credentials in startup records and browser failure hints; those now show only
the origin. The browser receives the unchanged private URL. The launch-token
failed-opener scenario already passed and is retained as equivalence evidence.
All 60 settings/diagnostic/startup cases and the existing WebSocket settings-read
redaction case pass.

The verify-first settings item #15009 also has a failing-before reproduction:
atomic saving replaced the settings symlink, and edits to a destination outside
the profile were missed. Settings and keybindings now opt into linked atomic
writes; other asset writers retain their existing policy. The destination is
canonicalized and checked again before publication. Tests preserve relative and
dangling chains, reject cycles and target substitution, follow repointed links,
and retain an external keybinding edit immediately after an app write.

The shared settings watcher attaches before startup returns and owns a one-entry
invalidation queue. A deterministic test covers coalesced remove/create events.
Native probes also reproduced entirely missing notifications for a first atomic
save, so an owned 500 ms metadata check provides a fallback, with one check in
flight and no unchanged-file reads. All 68 focused settings/keybinding/writer/
watcher cases pass. These checks do not claim a race-free filesystem rename;
Node has no portable directory-fd-relative rename API, so a directory substitution
after the last canonical-path check remains a filesystem race.

The larger server run exposed a checkpoint-worker race as well. A failing-before
VM reproduction shows that a busy NOOP result of `-1/-1` incorrectly cleared a
prior contention state. Unknown progress now retains that state, and incomplete
or busy checkpoints schedule another owned idle check. The pinned-reader test
now releases its reader without issuing another writer query; the worker must
catch up by itself. All 23 SQLite correctness/integration cases pass. The updated
40 MiB measurement is `/tmp/f5-october-checkpoint-measurement-2.json`, with five
warmups and thirty repetitions, a maximum event-loop p99 of 1.750015 ms, and
source-dirty/runtime/hardware/digest metadata retained in the report.

The subsequent Git audit also found missing explicit-bare discovery protection
and Windows long-path configuration. Both process paths now install these while
preserving inherited configuration and credentials. Worktree recovery rejects
option-shaped refs as creation does. Two real-Git failing-before tests found that
an option-shaped expected SHA could bypass conditional branch deletion, and that
deleting a symbolic branch could delete its target. Full SHA validation, an
option terminator and `--no-deref` fix those cases. See the
[Git security verification](./upstream-october-git-security.md) for source scope,
platform limits and scenarios.

## Remaining obligations

The ledger contains all 4,084 coverage records, including the 1,752 October
entries. October classification tests and the September overlay/carrier tests
exist. The 299 carrier members and 26 settlement overrides are preserved, but
their accepted behavior is not yet fully reconciled. Verify-first triage across
15a, 15r, 15t and 15u and the broader feature work remain outstanding.

The security cut line is also incomplete. Cross-frame preview redaction is now
implemented and passes the Chromium smoke and 34 focused tests; native Electron
launches abort with SIGABRT before producing a test result. See
[the snapshot verification record](./upstream-october-preview-snapshot.md).
#20446 remains deferred. Native Electron verification is still failed, and
the legacy OpenCode password migration described in the continuation above now
passes its persistence/recovery tests. These do not establish native Electron
snapshot verification. Settings/logging proof above is separate
from the preview tests.

## Validation

Formatting, lint, all eight typecheck packages, the upstream ledger gate and
`git diff --check` pass. The current exhaustive Git matrix passes 161 cases and
the smoke matrix passes eight. The focused Git/process suites pass 68 cases;
the three test-helper cases also pass after updating their explicit-bare argument
expectations. Focused
SQLite correctness/integration tests pass 23 cases; Claude adapter/private MCP
transport tests pass 287; preview snapshot tests pass 34, and all 558 desktop
unit tests pass.

`bun run test:full` was executed and still stops at two migration-recovery
creation-identity failures. Running the remaining workspaces independently also
finds the three existing standalone-launcher identity failures: this host rejects
`ps`/`/bin/ps` with EPERM. An additional asynchronous trace-test failure was
corrected with the flush barrier above. No identity check, assertion or timeout
was weakened. The full gate remains failed; these results are not a waiver.

A later complete server run passed 4,667 tests and failed five: the three launcher
identity cases, an unchanged workspace-directory watcher notification, and the
pinned-reader race described above. The SQLite correction passes its focused
suite, and the linked settings tests pass in that full run. The workspace watcher
failure remains recorded and has not been waived or hidden by a focused rerun.

The next server run, after the Git audit, passed 4,676 cases and failed six:
the same three launcher identity cases, the workspace watcher notification and
two helper expectations that still assumed implicit bare discovery. Those two
expectations now require explicit `--git-dir=.` selection and pass their focused
suite. The October/September classification tests pass in the scripts run;
that complete workspace still fails the two creation-identity recovery cases
(330 passed, two failed). The full repository gate was run again and remains
failed. No assertion was removed and no timeout was increased.

After merging main and retaining the missed-notification reconciliation,
the complete server unit run passes 4,681 cases and fails only the three
launcher identity cases (12 existing skips). All 18 workspace watcher cases
pass in that run. The server integration suite passes 25 cases, with 18
opt-in cases skipped; its Git smoke prerequisite passes eight. The exhaustive
Git suite passes 161 separately. The final `bun run test:full` still fails the
two scripts recovery cases above and does not reach its exhaustive Git stage.
Formatting, lint, all eight typecheck packages, the required-upstream ledger
gate and diff whitespace checks pass on the merged branch. The original
checkout remains untouched.

The isolated continuation passes 12 Markdown/terminal/Mermaid Chromium cases and
both shell source unit cases. Its production web build passes the initial-JS
budget at 1,495,371 bytes (40.5% below the fixed baseline); this is a bundle-size
check, not an interactive performance comparison. A new `env -i` full-gate run
again passes 330 scripts tests and fails the two process-identity recovery cases
before the exhaustive matrix. The host still denies `/bin/ps` with EPERM.

The isolated branch subsequently integrates main `f711d43051` through an additive
merge. It retains main's workspace-move snapshots and recovery proofs, its MCP
settings/runtime UI, and migration 123. Cleanup keeps both the active-thread
maintenance exclusion and verified owned-copy rollback checks; only automatic
cleanup gets the environment-file exception. Protocol 30 combines both branches'
contracts. No history was rewritten and the shared main checkout was untouched.

On this combined source, formatting, lint, all eight typecheck packages, the
required-upstream ledger and whitespace checks pass. The complete web unit suite
passes 2,280 tests, the exhaustive Git matrix passes all 162 cases, and the
selected Markdown/Mermaid/MCP runtime browser suites pass 13. The earlier full-app
shell execution case also passes, checking the exact sent command, fresh terminal,
worktree directory and absence of a model turn.

The complete post-merge server unit run passes 4,851 cases and fails only the
three launcher process-identity cases (12 existing skips). All workflow-storage
retention checks now pass on the preserved concurrent workflow changes. The full
repository gate was rerun after integration and again stops at the same two
scripts creation-identity cases. These failures remain required gates, not waivers.

The continuation adds `chat.sendAndNew` for existing-thread composers. It waits
for durable submission admission, preserves the draft on failure, and checks the
live router before navigation, including after asynchronous draft settings reads.
Mod+Alt+Enter follows the plan; the previous default for steering is removed to
avoid two actions on the same key. User steering bindings remain supported. The
focused web keyboard suites pass 68 cases and shared defaults pass 11.

The final send-and-new Chromium run passes all three acceptance, rejection and
navigate-away cases. All eight typecheck packages pass, followed by a separate
web typecheck after the final router guard. Formatting, lint, upstream coverage
and whitespace checks also pass. The combined server build succeeds. These UI
additions do not change the recorded failure of the full test gate or complete
the remaining workstreams listed above.

## Guided reviews, sync admission and scoped thread tools

The continuation implements manual reset waits, guided-review storage and UI, and the
initial thread tool catalog. These are implementation additions; no ledger entry has
been promoted while the full catch-up gate and remaining workstreams are unfinished.

- Manual sync waits only for read admission, frees its queue slot while waiting,
  cancels on account replacement and retries a rate-limited HTTP read once. Mutations
  and failures of an admitted operation are never replayed. Interactive sync retains
  its priority when queued behind a background sync. Scheduler/API/coordinator and
  discovery checks pass (118 targeted cases plus the 13-case discovery suite).
- Migration 124 stores review guides by account and PR, including run state and head.
  Generation is service-owned, coalesced, bounded to two workers/eight admitted PRs,
  and limited to three minutes. Publication checks account generation and the fresh
  head. Failed regeneration retains the previous guide; restart clears obsolete runs.
  The normalizer clamps excerpts and notes and adds omitted files to a skim stop.
  The model override is nullable and falls back to git text generation settings.
  The service and normalization checks pass 15 cases including account replacement,
  default-model fallback, failed regeneration, quoted UTF-8 paths and stale heads.
- The beta Guide tab supports generation, polling, stops, excerpts, notes, settings
  and retry. Both PR-head and loaded-diff-head changes hide excerpts. Its browser
  checks and the PR details/thread-summary/model-settings regressions pass 19 cases.
  GitLab's blank native head is now unavailable; native GitLab, Forgejo and both
  short/full Bitbucket head metadata have seven regression cases. This generator
  reads the bounded forge diff; it does not need upstream's temporary Git checkout
  or fetch-by-abbreviated-hash path.
- The `f5_thread` catalog contains thread status, guide read/generation, HTML publish
  and HTML screenshot tools. HTTP credentials are scoped to the thread and catalog,
  and disposed with sessions. Claude uses an in-process SDK server. ACP checks HTTP
  capability and excludes synthetic/read-only sessions; thread tools work on web
  servers as well as desktop. OpenCode and Muse receive no new catalog. Watch and
  settle tools remain obligations of their respective workstreams.
- Generated pages reuse the screenshot attachment ingress, recovery, ownership and
  200-item/64-MiB thread budget. Local images pass the existing inode/containment
  checks, including symlink/traversal rejection, before inlining. Source is limited
  to 512 KiB, individual images to 10 MiB and prepared pages to 25 MiB. Preview
  requests use expiring authenticated HTTP document reads rather than large socket
  pushes, with two admitted requests and a 15-second deadline.
- The desktop screenshot implementation uses offscreen sandboxed BrowserWindows,
  no Node integration, isolated ephemeral sessions, blocked navigation/popups and
  an eight-MiB PNG limit. Three desktop unit cases verify configuration, ownership
  authorization, deadline teardown and admission bounds. Actual native Electron
  execution remains subject to the previously recorded host smoke failure; these
  mocked checks are not a native certification claim.
- HTML rows use opaque `allow-scripts` frames with first-policy CSP, bounded fetches,
  fullscreen/zoom, external links and the existing image viewer/copy path. A private
  MessageChannel is established by the first bootstrap script before page code;
  raw window messages cannot invoke app actions. Native key getters are captured
  before page code so configured trusted shortcuts still work after prototype
  replacement. Six Chromium cases cover isolation, links/images, fullscreen Escape,
  forged messages/handshakes and shortcut forwarding. The source, preview broker,
  catalog and shared attachment regressions pass 20 server cases.

All eight typecheck packages and the 570-case desktop unit suite pass at this point.
Formatting, lint (warnings only) and whitespace checks pass. The overlapping broad
web runs hit two five-second import/render timeouts under load; the serialized rerun
and current complete server results are recorded below when finished. The mandatory
full gate remains outstanding, with the existing process-identity failures unchanged.

The serialized complete web unit rerun passes all 2,280 cases. The broad server run
identified an additional regression: sync was waiting through the scheduler's
network-failure circuit as though it were a rate-limit reset. Separate network and
rate-limit deadlines now preserve both cooldowns, and only rate-limit reset waits
are admitted. A failing-before recovery scenario now passes in the 49-case PR Hub
suite; together with scheduler and wait tests, all 62 targeted cases pass. The broad
run before this correction passed 4,890 server cases, failed that scenario and the
three existing launcher creation-identity cases, and skipped 12. Those launcher
failures still reproduce the host's denial of `/bin/ps`; they are not waived.

## PR watch continuation (2026-10-19)

The pinned upstream `evaluatePullRequestWatch` decision logic is ported with its
15 behavior cases. Migration 125 persists watches per thread, account and PR.
Incarnation IDs and version compare-and-swap checks reject late results after
Stop/restart. Polls share account/PR reads, use conditional GitHub fingerprints,
revalidate the verified account generation before publication, bound pagination,
and preserve the remark watermark after partial reads. Quiet native-forge reads
fall back after ten minutes; GitHub activity has a thirty-minute safety refresh.
The real GraphQL quota cost has not been certified against a live account.

Watch state and automatic NextTurnQueue submissions commit in one transaction.
Trusted automation provenance is stored separately from message text. The new
`pull_request_watch` queue reason allows Stop to remove pending watch continuations
while retaining restart-recovery protections and the ordinary queue capacity.
Manual Stop atomically removes the watch and cancels its pending wakes. Archive,
turn interruption and terminal PR state stop watches; rate limits pause without
counting toward eight failed reads. Watch state has a 64 KiB bound, global/thread
limits, four concurrent PR reads and a sixty-second read deadline.

Protocol 32 exposes list/start/stop and change pushes. Scoped thread catalogs gain
watch/unwatch for Codex, Claude and eligible ACP providers. The header's PR menu
starts/stops a watch; its eye stops it directly. Watches without an explicit PR
link remain visible and stoppable. The feature starts only on explicit request.

Validation so far: 90 focused watch, forge, cache, catalog and queue tests passed;
the final service suite adds account-incarnation and quiet-fallback cases (8 pass).
Three Chromium menu/eye/push/failure scenarios pass. Formatting, lint and the
4,084-record ledger check pass. Full workspace typechecking initially found two
incomplete mock definitions; those definitions have been corrected and all eight
workspace typechecks pass. `bun run test:full` ran again and failed on the same two
migration recovery process-identity checks (`ps` EPERM): 330 script tests passed.
This is not a waiver or a declaration that the full plan or cut line is complete.
Settlement and the other outstanding workstreams remain implementation obligations.

Durable Stop follow-up: archive, deletion, turn interruption and session Stop now
remove saved watches and pending watch submissions inside the orchestration command
transaction. This prevents a restart between command acceptance and live subscribers
from reviving a watch. Already admitted/dispatching deliveries remain recoverable.
The direct transactional regression and full engine suite pass 32 tests.

## Settlement continuation (2026-10-19)

Migration 126 and protocol 33 add persisted settlement state, per-thread opt-out,
wake anchors and server/project rules. Both automatic rules default off. The
server checks queue, request, background-work and watch state within the settlement
transaction. New work prepends its wake to the same event transaction. Persisted
human/automation provenance makes the PR timestamp rule conservative for unknown
historical messages. PR reads share one result per key per sweep, admit four
threads concurrently, cap remote reads at 32 with a 15-second deadline and rotate
the starting thread for fairness. Newly linked PRs are tracked before reading;
stale reads and account-generation changes retain active threads.

The sidebar has a collapsed Settled group, explicit wake control, row/menu actions,
a project bulk-idle action and an unbound toggle command. The header exposes the
per-thread preference. Global and project settings use the existing persistence
and source routing; checked-in files cannot opt into automatic rules.

Settlement scripts use durable pending/running/completed/failed/canceled/orphaned
jobs and the shared owned-project-process runner. Cleanup protects pending,
running and orphaned claims. Ordinary failure adds a fixed notice and releases
its claim only after owned process finalizers finish. Success and failure trigger
a fresh cleanup safety evaluation. Restart never replays an unverified running
script; its orphaned claim cannot be overwritten by another settlement. Wake
cancels the live job before releasing its claim. Idle terminal closure uses a
fresh child-process probe, checks intervening input and preserves history.

The plan's migration numbers 117/118 are already occupied by integrated main
work; this implementation uses 126 rather than rewriting migration history.
Closed-PR settlement requires the same explicit opt-in as merge settlement,
and future snoozes and pending user inputs remain protected as required by the
approved f5 plan. Upstream default-on and automatic snoozed-settlement behavior
are intentionally not adopted. The individual September and October settlement
follow-up proof remains to be reconciled; no ledger entry is promoted by this
implementation alone.

Settlement validation passes the focused server suites (180 distinct cases after
correcting the on-settle-only resolver regression), all 54 storage maintenance
cases, all 48 sidebar/control Chromium cases, 104 earlier store/sidebar unit
checks and 52 subsequent visibility/attention/preload checks. The settings
contracts pass, including partial cleanup-patch preservation and the 365-day
bound; shared project settings pass all ten checks. The exhaustive real-Git
matrix passes 162 cases again. The required full command ran and stopped at the
two existing migration-recovery process-identity failures (330 scripts checks
passed). Final typecheck and format results are tracked with the implementation
commit; this record does not waive the failed full gate.

## Codex MCP apps continuation (2026-10-19)

Migration 127 and protocol 34 add owned MCP app snapshots, live-session RPCs and
persisted latest model context. The native protocol manifest includes resource
reads and tool calls. Completed Codex MCP tool calls capture exact `ui://` HTML
resources before turn completion, with ten-second capture deadlines, two active
reads and bounded admission. Failure retains the ordinary tool row. Captures are
owned by adapter scope and release completion barriers on shutdown.

The web host ports the pinned upstream MCP JSON-RPC host into the existing F5
runtime. Apps use opaque sandboxed frames, declared-origin CSP, theme and cookie
compatibility bootstraps, and a private document-liveness channel. Navigation,
unmount and replacement revoke bridge access. Live session identities bind tool
approvals; both the RPC service and native manager re-read tool visibility and
read-only annotations before a single mutation. Every app message uses explicit
confirmation and normal durable submission. Saved context has per-app and aggregate
budgets and is delivered separately from the user text on the next ordinary Codex
turn. Offline frames explain how to reconnect; prior-turn apps remain visible when
work logs collapse. Fullscreen exits on Escape or any app/native approval.

Source reconciliation covers #16236 (capture, routing, context and host), #17026
(saved-document theme bootstrap), #17027 (blocked-cookie compatibility), #17962
(scrollable full argument approval with visible decisions), and #20691/#20759
(stable bridge lifetime without manual memo hooks). F5 snapshots already travel
through its owned attachment route; upstream's signed asset URL/cache refresh
mechanism has no matching implementation to copy. Instead, the attachment ID and
frame nonce define bridge lifetime, and a browser regression preserves the bridge
through native approval updates. Mobile branches remain outside this web/desktop
port. Individual ledger promotion still requires the plan's release gates.

Validation: the nine provider/capture/context suites pass 574 cases (one existing
skip). The subsequent native-input test brings the adapter suite to 69 cases and
passes alongside both capture cases. All 78 app/timeline Chromium scenarios pass
before the additional long-argument approval scenario; all ten app scenarios then
pass with that bounded-approval case. Shared policy/encoding tests pass 17 cases,
and the final web host/session/timeline unit suites pass 165. All eight workspace
TypeScript checks pass, lint has no errors, and the required full command ran:
330 script checks pass and two process-identity recovery checks fail because this
host denies `ps`. The full gate remains failed; no completion waiver is claimed.

## Project provider policy continuation (2026-10-19)

Project settings now include a narrow per-instance enabled policy. Omitted policy
maps survive partial project patches, an explicit empty map restores inheritance,
and resetting the whole project clears it. Checked-in files cannot change it.
The shared resolver handles default and custom instances. Project resolution
preserves opaque driver configuration and selects a project-enabled fallback for
background text generation. The original saved model preference remains intact.

Runtime hydration activates a provider when a project explicitly enables it,
while registry reads, refresh results and push streams retain global enablement.
Session admission checks the requested project independently. Turn delivery and
session recovery recheck that policy, while stopping a session remains available. Model pickers and
new-draft defaults apply that same resolver. The Project settings page lists each
configured provider and can restore global inheritance. Agent Bridge lists accept
an optional exposed project ID, reject hidden projects and apply the policy before
new-thread provider selection. Title and Git generation resolve the registered
root or linked worktree with the same shared project lookup, use an enabled
fallback and fail closed when every provider is off. Custom ACP remains a separate
unfinished part of 15k.

Focused validation passes 111 server policy/admission/bridge/generation tests,
28 publication/Git-manager regressions, 25 shared settings cases, 22 web unit cases
and 12 settings/model-picker Chromium scenarios. All eight workspace typechecks
pass before the final admission regression. The required full command ran again:
330 script tests pass and the same two migration-recovery checks fail on denied
process-identity probes. Formatting, lint and the upstream ledger check pass.
No deferred ledger obligation is promoted solely by these implementation tests;
the full gate is still failed.

## Cross-feature integration follow-up (2026-10-19)

The broad server suite exposed integration failures hidden by the root test
command's earlier script failure. The settlement migration now reuses the
idempotent core-schema repair before adding foreign-key dependents, skips missing
historical provenance and safely ignores malformed historical JSON. A direct
regression verifies repeated migration, row preservation and positive-evidence-only
automation backfill. Migration fixtures now use shared child-first teardown with
foreign-key checks kept on. Exact projection expectations include the new optional
settlement fields. All seven watch/settlement/MCP thread-reference tables have an
explicit cascade purge policy; the existing schema-coverage test verifies their
foreign keys. The passive reconciliation runtime fixture includes the new service
tags so it exercises its intended asynchronous path.

The focused schema/projection/purge run passes all 81 cases; the new provenance
suite passes both cases, and the passive-reconciliation regression passes. All
eight workspace typechecks and formatting/lint pass. The broad suite is rerun
after these fixes: 4,998 cases pass and twelve are skipped. Only three launcher
process-identity checks fail under the host's `ps` restriction. This is not a waiver.
The ledger and classification artifact attach implementation SHAs and scenario
files to the six MCP app entries and #17879. Their dispositions stay deferred
while the required full-workspace gate is failed.

## PR comment filter continuation (2026-10-19)

The Review threads tab now has persisted, independent bot-comment and resolved-thread
filters, both hidden by default. GitHub bot metadata and native forge bot flags are
retained, with the standard `[bot]` suffix as a fallback. Unknown authors remain
visible. Filtering never changes resolution or reads extra pages automatically;
a bot-rooted thread with unloaded replies stays reachable so a human reply cannot
be stranded. Both thread and reply pagination remain available.

Nine focused server cases, 131 web unit cases and both Chromium scenarios pass.
The browser scenarios cover persisted choices across remounts, independent filters,
and loading a human reply beneath a hidden bot root. Formatting, lint, all eight
workspace typechecks and the pinned upstream ledger check pass. This implements
the plan's Review threads surface for #17645; the remaining PR UX work and full
release gate are still outstanding. Ledger dispositions remain deferred.

## Per-item forge permissions continuation (2026-10-19)

Native discussion normalization now retains optional `canEdit` and `canResolve`
answers. Explicit edit permission overrides authorship; explicit resolution denial
narrows repository capabilities. Timeline edits, thread resolve/reopen controls and
fresh server-side preparation/submission checks use these answers. Saved previews
cannot authorize an edit or resolution after the host revokes it. GitHub timeline
queries also read `viewerCanUpdate` on issue and inline comments, retaining the
older authorship fallback only when the host omits the field.

The six focused server suites pass 39 cases, including permission revocation
between preview and submission. Six Chromium cases cover native editing and the
absence of a denied resolve action. Formatting, lint and all eight TypeScript
checks pass. The required full command ran for this continuation: 330 script
checks pass and the same two process-identity recovery checks fail. No full-gate
waiver or ledger promotion is claimed.

## PR link and panel continuation (2026-10-19)

PR links now open a reusable PR surface beside the originating thread. The normal
PR model and mutation paths are reused; opening a link only reads the forge and
saves its local tracked-PR model. Tab identity is the PR reference, so repeated
links reuse the tab; normal close history can restore it. No current thread uses
the existing PR route. The Browser setting can send all PR clicks to the system
browser, and modified/middle clicks explicitly bypass both the PR panel and the
preview browser. The web-local setting lives only in `appSettings.ts`.

Panel action confirmations reuse the existing forms and durable submission paths
inside the panel. They preserve the thread draft, and preparation still requires
a second explicit submit. Failed panel reads offer Retry and Open on forge. Every
read captures the selected account generation and discards a response after an
account change. This implements the F5 surfaces for #19719, #19854 and #17710.

Validation passes 19 Chromium scenarios across link routing, account response
ownership, inline merge preparation/confirmation, panel hosting and Browser
settings. The focused unit run passes 148 cases. Formatting, lint and all eight
TypeScript checks pass. A subsequent broad web run is recorded separately below.
The release gate remains failed on the process-identity checks described above;
these implementation scenarios do not promote the deferred entries.

The broad web suite passes all 2,301 cases in 236 files. A follow-up directional
permission regression also preserves a host's separate reply, resolve and reopen
answers through shared native normalization; all 23 focused model/operation cases
pass. The exhaustive real-Git matrix from the prior integration run remains 162
passing cases; this UI continuation does not change Git execution.

## Linked PR context chip continuation (2026-10-19)

Linked PRs export a bounded, versioned drag payload. The composer claims that
payload before the editor's native drop handler and inserts a PR reference chip.
The complete Markdown PR reference is the persisted and sent prompt source;
no extra host read or file-authorization grant is inferred. Cursor conversion,
selection protection, materialization, deletion and undo treat it as one token.
Malformed and oversized payloads are rejected. The shared syntax parser also
recognizes self-hosted forge paths for in-app PR links. This is the F5-native
implementation of #20102 using its existing persisted prompt path.

Validation passes 160 parser/cursor/draft cases and 21 Chromium editor/header/link
scenarios. A real ChatView regression drops the chip, verifies no turn started,
then explicitly sends and asserts that the complete PR URL reaches the turn
command with no file authorization. All eight TypeScript checks passed before
the final browser fixtures; the final check includes those fixtures. The full
release gate remains failed and ledger obligations stay deferred.

## Merge-message attribution continuation (2026-10-19)

The profile setting for #16192 is opt-in and off by default. GitHub HTTP merges
read the host's proposed message only when needed, remove recognized agent credits
with the pinned upstream parser, and retain human/unknown credits and fenced or
quoted examples. A changed body is tied to the read head SHA; stale or incomplete
reads fail before a merge write. An explicitly empty cleaned body is sent as empty,
while unchanged bodies leave the host default intact. Rebase skips the read.

The native forge action uses the same HTTP merge implementation. Auto-merge uses
the same cleanup and an `expectedHeadOid` fence, retaining the prepared method.
The [GitHub auto-merge input schema](https://docs.github.com/en/graphql/reference/pulls#enablepullrequestautomergeinput)
confirms the head fence and optional body fields. Merge queues retain the host's
message, and the existing native stack merge endpoint bypasses this cleanup.
F5 exposes a profile setting; the plan did not require project overrides for this
setting. No automatic merge or branch deletion is introduced.

The five focused server suites pass 115 cases, including default/off behavior,
merge/squash, human credits, empty/unchanged bodies, queues, rebase, failed reads,
head changes and auto-merge activation. All 15 settings-contract cases and all
eight workspace TypeScript checks pass. Formatting and lint pass. The required
full gate remains a separate outstanding condition; dispositions stay deferred.

The required full command was repeated after the PR chip and merge-message changes.
It still stops at the two migration process-identity failures (330 script cases
pass). Seven PR UX records now carry concrete implementation SHAs and scenario
files in both October artifacts; every disposition remains deferred. The ten
September/October artifact reconciliation tests and pinned ledger validation pass.

## PR quick actions and row menus continuation (2026-10-19)

The inbox and linked-PR header expose Shift-only quick actions and right-click
menus (#15549, #16612, #16627). Forge capabilities now live in one shared runtime
module used by server adapters and web action selection (#17774). Server-reported
permissions narrow those defaults. Archived/merged PRs expose no quick mutations;
known closed PRs offer only supported reopening. Unknown/unsupported forges stay
conservative. The header has only stored link metadata, so its action request
opens the thread-owned PR panel for a current account/state read before admission.
No new remote read occurs merely to render or reveal quick actions.

F5 retains explicit preparation and confirmation for remote changes. A quick
request opens the existing form, rechecks the loaded PR capabilities and is
consumed once without changing other tabs. Canceling, tab changes or restoring a
closed tab cannot replay that request. Shift state clears on other modifiers,
blur and visibility changes. Inbox keyboard navigation remains intact, including
the virtualized list.

All 22 Chromium scenarios across the header, inbox, quick-action forms, spine and
PR panel pass. The focused web run passes 35 cases and the broad web run passes
2,320 cases in 238 files. All 85 focused server capability/model/operation cases
pass. Formatting, lint and all eight TypeScript checks pass. The last required
full run still fails its two process-identity checks; no release waiver is claimed.

## Opt-in branch cleanup continuation (2026-10-19)

The #19257 merge/close toggle starts off and records the choice in the saved
operation before dispatch. GitHub deletion uses GraphQL updateRefs with the exact
reviewed beforeOid and a zero afterOid. Fresh reads reject open PRs, stacks,
base/default branches, unwritable or archived source repositories, changed heads,
and incomplete responses. The captured account and exclusion guards still apply
after the primary action closes the PR. Remote results and local cleanup warnings
are reported separately, so a confirmed merge is never presented as retryable
because branch cleanup failed.

Local cleanup searches only registered projects with matching source-repository
remotes. It keeps default/current/worktree-owned branches and compares the local
ref to the reviewed head under the repository lifecycle lock. Recovery performs
read-only remote absence checks; it never repeats a merge, close, remote deletion
or local cleanup after an uncertain response. Protocol 35 adds the explicit forge
action; other forge adapters do not advertise it.

The focused server run passes 95 cases, including 14 real-HTTP branch-admission
cases, eight local cleanup cases, 24 durable-operation cases and 49 existing PR Hub
cases. All 163 exhaustive real-Git cases pass, including an occupied-worktree and
moved-head deletion scenario. The seven Chromium native-action scenarios pass,
including an unchecked default, explicit opt-in, locked prepared payload and
separate confirmation. The legacy merge regression also verifies that cleanup
failure returns a warning with exactly one primary merge. Required full-workspace
validation is still a separate obligation; this evidence does not promote any
ledger disposition.

The required `bun run test:full` was repeated for this continuation. It fails the
same two scripts migration-recovery cases because process creation identity cannot
be verified on this host (330 script cases pass). The launcher suite also reports
its three process-inspection failures before the scripts failure stops Turbo. The
exhaustive Git matrix was run independently and passes all 163 cases. These are
reported failures, not a waiver or a reason to weaken recovery ownership checks.

## Custom ACP agents continuation (2026-10-19)

The `acp` driver (#16021) uses the existing ACP runtime and adapter with a typed
command, argument array and environment map. Commands execute directly. Instance
environment entries override config defaults through the existing profile/account
environment boundary. Custom agents have no implicit default instance. The Add
provider dialog and instance card share field decoding and preserve unrelated
configuration. Model catalogs come from session config options and remain scoped
to the instance; model selection uses the config-option method when available.
Metadata generation uses the same account in a temporary workspace with typed
output. A model update does not spawn another health probe.

Health probes send only `initialize`, advertise no client capabilities and stop
after ten seconds, including child-process cleanup. They do not authenticate or
create a session. Session startup leaves authentication to the preconfigured local
agent rather than choosing an auth method. Preview/computer verification flags
remain false; the MCP server rejects custom ACP computer scopes. Existing session
approval/cancel/resume and private protocol-based MCP setup are retained. Protocol
36 adds the provider kind. See `docs/providers/acp.md` for setup and limitations.

The six focused server suites pass 49 cases, including real executable/argv
handling, initialization-only probes, native model selection and the ten-second
silent-agent deadline. The driver integration test proves separate instance
catalogs, one initialization per probe/session, and schema-validated metadata.
The two settings Chromium suites pass 21 cases; the focused web run passes 33
cases. All eight workspace typechecks, formatting and lint pass. The broad web
suite passes 2,332 cases after updating two explicit provider-list/closed-gate
expectations for ACP. Full-workspace delivery remains conditional on the required
full gate; no ledger disposition is promoted by this implementation evidence.

The required full command was repeated after fixing those ACP expectations. It
fails the two existing migration-recovery process-identity cases; the launcher
suite reports its three existing failures before Turbo interrupts the server
workspace. The web and shared workspaces pass. This is an outstanding gate, and
process ownership checks have not been relaxed.

## Current main integration continuation (2026-10-19)

Main `83e054f412` is integrated without rewriting history. Conflict resolution
retains the October settlement/watch cancellation and pending hook records along
with main's durable archive queue pause, restore reconciliation and deleted-thread
ownership checks. Main's explicit ignored-file confirmation, exact reviewed-change
discard, project-root/active-thread checks and short orchestration maintenance
locks remain in place. Automatic cleanup uses storage maintenance's build-output
policy for ignored files; an earlier environment-file-only rule was withdrawn
because it applied to every automatic cleanup rule, including rules users had
enabled before this change. Manual removal keeps explicit approval. Collapsed
ignored folders, bounded protected-file scans, real truncation, index-preserving
status and exact-head unused-branch deletion remain intact.

The thread view retains the October media/quote/shell/PR/MCP-app behavior and main's
MCP sign-in tray and runtime metadata actions. Both Git settings editors remain
available. All 163 exhaustive Git cases and 146 Chromium cases across the actual
thread view, PR confirmations and provider settings pass. The six targeted
workflow/turn-admission/worktree suites pass 340 cases; the additional archive,
settlement, storage and engine suites pass, with the two old policy-message
expectations adjusted to the explicitly selected automatic policy. Formatting,
lint and all eight typechecks pass. The required full command is repeated after
integration; no process-identity failure is waived.

## Branch-based settlement continuation (2026-10-19)

Unlinked saved branches now use a bounded PR lookup without worktree status or
index refresh. It captures remote URLs, saved upstream, branch refs and default
branch before and after the request. Ambiguous tracking refs, missing identity,
changed refs, unknown states and terminal heads that do not match the branch
refuse settlement. A newer open PR blocks an older linked terminal PR. A surviving
exact remote-tracking ref supports a removed local branch. GitLab, Azure, Forgejo
and Bitbucket now support bounded all-state listing; incomplete pages fail closed.

Terminal details use actual merge/close timestamps, never updated timestamps.
Unlinked reads do not add inbox tracking. Account generation and repository
exclusions are rechecked after reads, and GitHub checks exclusions at admission.
Local thread guards and settings are reread after remote waits. Branch/detail
reads share a 32-request sweep budget, coalesce matching proofs and rotate for
fairness. Exact-head proof has a separate cache identity from inbox freshness;
a failing-before regression caught and fixed unsafe reuse of the linked PR read.
All automatic behavior remains off by default. Hosts without actual terminal
timestamps retain the thread rather than guessing from recent updates.

The five focused suites pass 142 cases. The exhaustive real-Git matrix passes
165 cases, including preserved HEAD, index and dirty-file checks. Formatting,
lint and all eight workspace typechecks pass. The required full command ran and
fails the same two scripts migration process-identity cases (330 pass). The prior
independent server run after main integration passed 5,133 cases with 12 skips
and the three launcher process-inspection failures. These failures remain open;
no ownership protection or full-gate requirement has been waived. The 26 settlement
source records still need their individual final reconciliation and remain deferred.

## Find in thread continuation (2026-10-19)

`chat.find` opens with Mod+F or the command palette, outside the terminal and
preview browser. The new read-only `threads.search` RPC searches persisted user
and assistant messages and proposed plans, including history outside the loaded
tail. Enter/Shift+Enter navigate occurrences; Escape closes and restores composer
focus. Failed searches or history loads offer Retry. Replaced queries cannot
publish stale results. Opening, typing and navigating never submit a turn.

A dedicated read-only SQLite connection uses deferred transactions and does not
reserve the writer. Both Node and Bun reject writes through that connection. A
real two-connection test holds a reader snapshot while the writer commits, then
observes the new value after the snapshot closes. Searches page metadata in
64-entry batches, hold one message body at a time, retain counts rather than
bodies, and bound cached scans. Every projector's revision contributes to cache
invalidation, including a lagging projector advancing below the maximum cursor.
Oversized bodies, excessive entries and deadlines report failure instead of
claiming partial coverage. Unicode case folding preserves offsets; Markdown
formatting and link targets are excluded from displayed-text matching.

Navigation hydrates unloaded message history and the selected historical plan.
The selected plan expands through its collapsed preview. Highlights span inline
syntax nodes, retain the selected occurrence beyond the 2,000-highlight display
bound, and scroll that occurrence into view. Cleanup checks highlight ownership
so an old virtualized row cannot clear the next row's highlights. Protocol 37
adds the RPC; it introduces no automatic provider action.

The full thread/find Chromium run passes 127 cases. The additional settings,
workflow-dialog and recency suites pass 89 cases; focus guards pass separately.
All 2,333 web unit cases pass. The focused snapshot/SQLite/WebSocket run passes
173 cases with two existing skips. The independent full server run passes 5,169
cases with 12 skips and the same three launcher process-inspection failures.
The required root full command ran and still fails the two migration recovery
identity cases (330 pass), so the release gate remains open.

The production build initially failed the fixed JavaScript budget. Routing now
shares one identity/scope record with each full settings descriptor; descriptive
search text loads only with Settings. Registry parity, legacy item/category links
and project scopes retain their existing behavior. The last measured initial
JavaScript is 1,489,048 bytes, below the unchanged 1,507,108-byte limit. Workflow
creation loads its dialog on demand. This is bundle-size evidence, not a CPU or
latency comparison.

Production startup also exposed a generated-helper import cycle. A separate
bundler runtime chunk prevents consumers from calling an uninitialized helper,
following [Rolldown's runtime chunk guidance](https://github.com/rolldown/rolldown/blob/main/docs/in-depth/manual-code-splitting.md).
The OpenCode v2 SDK and diff parser are bundled because their import-only exports
cannot be required by the CommonJS artifact. Node ESM and CommonJS and Bun ESM
`--help` now run. Chromium against the actual built Node server passes in both ESM
and CommonJS: an older message and a long folded plan are found and highlighted,
with two search RPCs, no mutations and no page errors. This does not replace the
remaining native desktop and comparative-performance obligations.

## Pi integration groundwork (15l; delivery still deferred)

The new Pi transport speaks LF-delimited RPC without readline, preserves Unicode
line separators, bounds frame size, buffered bytes, queued frames and pending
requests, and correlates reordered replies. Timed-out host replies cannot become
turn acknowledgements. Real child-process tests cover crashes, early stdout
closure, cancellation and SIGTERM-resistant processes. Transport errors omit
private provider payloads.

Model discovery preserves provider/model identity and applies the active thinking
default only to that model. Commands retain workspace skill metadata and the
native compact command. The MCP extension supports mixed text/image results,
structured script results, optional tool discovery and completion-gateway schemas.
Only owned bridge tools and native builtins inherit read-only approval bypasses;
replacements require approval. Missing runtime policy defaults to approval-required.
HTTP bodies, pagination and selected skill reads are bounded. Native tree helpers
walk active ancestry and reject ambiguous rollback boundaries.

Metadata runs in disposable directories with extensions, tools, persistent history
and inherited MCP credentials disabled. Shared source-control prompt generation is
now used by Muse and Pi. Real CLI fixtures verify model selection, successful retry,
native abort/error outcomes, output bounds and admission before spawning. The
focused Pi, Muse and text-routing run passes 107 cases. The required root full run
still fails the same two migration-recovery process-identity cases (330 scripts
pass); its other completed workspaces pass 723 shared, 570 desktop, 2,333 web and
21 ACP cases. The strict upstream ledger check passes without disposition changes.

At groundwork commit `165260f360`, Pi was not registered or selectable. The following
continuation adds the driver and session integration; neither checkpoint promotes
Pi ledger records or claims the complete 15l phase.

## Pi session and driver continuation (15l; delivery still deferred)

Pi is now a registered, explicit-instance driver with an Early Access settings entry,
qualified model/thinking selection, version admission at 0.80.5, five-minute status
refresh, live workspace models/commands/skills and `pi update --self`. Hydration does
not synthesize a Pi instance from legacy settings. The F5 thread catalog is supplied
through a scoped HTTP MCP session; only the owned live child receives its bearer.
Account admission guards probes, sessions and isolated text generation. Isolated
profiles strip ambient Pi roots and additional model credentials while preserving
explicit instance API keys. Setup remains described in `docs/providers/pi.md`.

The adapter owns startup, child processes, event pumps and metadata operations in
its instance scope. Caller cancellation and instance replacement interrupt in-flight
startup and reap its child. A Deferred-based completion bridge avoids a pinned
Effect observer-notification problem when scope closure interrupts an owned fiber.
Shutdown closes the bounded event bus before session cleanup; a regression fills
it with 600 native notifications while its consumer is blocked and proves shutdown
still reaps the child. No unbounded event queue was introduced.

Native acknowledgements, settlement and stream-ordered idle probes fence turn
completion. Late replies and duplicate acknowledgements cannot finish another
turn. Aborts, command-only prompts, failed/crashed processes, compaction and retry
outcomes retain explicit ownership. Model changes require native read-back; a
mismatch blocks the session and reports the prompt as known not sent. Read-only
workflow tool restrictions precede all permission modes and never ask to grant a
mutation. Replaced tools cannot inherit builtin read/edit exemptions.

Assistant text and reasoning get bounded start/delta/completion projection, including
final-only messages and missing suffixes. Completed message buffers are released.
Tool calls have correlated, bounded structured completion envelopes, original shell
exit codes and separate transport/semantic outcomes. Native inline image bytes are
scrubbed before events are queued; the existing authenticated attachment store
retains at most one supported final-result image and counts omissions. The shared
image-store extraction does not certify Pi computer automation. Per-message usage
replaces streaming counters rather than adding them repeatedly; billable turn totals
remain separate from Pi's authoritative native context occupancy.

Editor prefill now survives the shared question schema, persisted-activity parsing
and both question panels. Initial drafts seed once; editing or clearing a draft
cannot restore the provider's original text. Chromium checks cover explicit empty
answers, no automatic turn submission and restoration of the original composer
draft. Approval generations, native ids, deadlines and one-shot responses prevent
answers from crossing session replacement or surviving native expiry.

Native history reads walk active ancestry and verify the file/leaf before returning.
F5 rollback forks at a captured native user entry, adopts and persists the new file
before hydration, verifies exact retained native/host boundaries and recognizes a
verified retry without issuing another fork. Lost acknowledgement, changed history
or failed read-back blocks further prompts. Pi's session-file identity now participates
in the shared rewind preparation and recovery path. Uncoordinated native extension
rewinds/session switches also block prompts instead of silently continuing against
stale F5 history; their automatic projection reconciliation remains unfinished.

Validation: the combined targeted server run passes 279 cases in 24 files; the
latest adapter run passes 19 cases including native mutation blocking. The runtime
ingestion/lifecycle run passes 181 cases, web unit tests pass 150 cases, the async
question panel passes 14 Chromium cases and the focused ChatView prefill run passes
2 cases. Formatter, lint (31 existing warnings, zero errors), all eight workspace
typechecks and strict upstream coverage passed at this checkpoint. The required
`bun run test:full` was run again and failed: 330 scripts pass, two migration recovery
cases cannot verify process identity, and three launcher cases fail before Turbo
interrupts the remaining server run. `/bin/ps` remains denied with EPERM in this
host. No safety check was weakened and no release-gate waiver is claimed.

Remaining Pi obligations include owned extension continuations, corresponding queue
admission and automatic native-history projection reconciliation, plus real installed
Pi/account evidence. The broader catch-up and mandatory verify-first cut line also
remain incomplete. All Pi dispositions stay deferred.

The independent server workspace run subsequently completed: 5,355 cases pass,
12 skip and only the three known launcher-identity cases fail with `/bin/ps`
EPERM (532 files pass, one fails). This also exercises the registered Pi driver
against the remaining provider, orchestration, queue and WebSocket suites. A fresh
`origin/main` fetch confirms the branch has no commits behind main; its history
remains integrated additively. The strict ledger and all ten October/September
plan tests pass after attaching per-SHA Pi evidence to sixteen still-deferred
records. No delivery counts changed.

## Pi native continuation admission and assistant-only history (15l; deferred)

An instance-scoped broker now retains at most 64 native wake owners, with eight
concurrent admissions and a ten-second deadline. The worker admits the exact owner
through the durable turn queue after checking project/provider policy, thread state,
pending input, pause state and competing queue items in the writer transaction.
Delayed settlement or the source command's delivery cleanup waits within that same
deadline. Replaced owners cannot clear or adopt a newer wake. Rejection stops the
owned native child and removes only the obsolete queued continuation; definitive
not-sent delivery rejection releases its internal queue item without dropping a
user item or treating an ambiguous outcome as safe to replay.

The adapter buffers at most 256 events and 2 MiB while admission is pending, retains
native dialog expiry, and adopts ordered output without another Pi prompt. The
continuation command is internal: client decoding rejects that field. Session
recovery cannot turn a stale continuation into a fresh prompt, and history/rollback
cannot race a pending wake. Assistant-only native turns now retain an independently
verified entry identity; rewinding a later user turn preserves them. A direct fork
before an assistant-only turn is refused because Pi has no native user boundary.
Full retained-branch hashes protect rollback read-back, including those turns.

Production integration exposed a capability lookup that used a provider-kind
default instead of the selected explicit instance. Both reactor lookups now carry
the active instance id; the service verifies its kind and never starts a session
while reading capabilities. This also corrects explicit custom ACP routing.

The latest focused run passes 285 tests in eleven server files, including all 84
ProviderService and 77 ProviderCommandReactor cases. All eight typechecks pass.
Formatter and lint pass (31 existing warnings). The production smoke uses a real
built Node server, Chromium, SQLite, queue worker and an owned fake Pi RPC child;
it requires two assistant messages from one live child and exactly one native
prompt, an empty unpaused queue, and zero browser errors. It is integration
transport evidence; installed Pi authentication and automatic native rewind
projection reconciliation remain pending. The full catch-up is not delivered.

The fresh production build passes all five tasks. Its latest Node/Chromium smoke
passes with two assistant messages, one live Pi child, one native prompt, no queued
items and no page errors. The required full run was repeated: desktop 570, shared
725 (one skipped), web 2,343 and contracts 226 pass. Scripts pass 330 cases and fail
the same two process-identity migration cases; the server reports the same three
launcher-identity failures before interruption. The exhaustive Git matrix is not
reached by that failed root run. The strict 4,084-record ledger check passes.
No full-gate waiver or delivered Pi disposition is claimed.

## Pi native rewind projection reconciliation (15l; delivery remains deferred)

The adapter now verifies complete active ancestry in the same idle session before
and after a bounded orchestration acknowledgement. Only captured native entries
missing from that branch identify abandoned host turns. Session switches, malformed
or partial ancestry, lost acknowledgement and changed read-back keep prompts
blocked. No native fork or file restore is issued by reconciliation.

A server-only command fences the exact active Pi instance and current turn. Its
event removes only proven abandoned turn ids and the user/assistant message ids
linked through their persisted turn rows. The latter is necessary because F5 user
messages normally have null turn ids: a real production fixture found and now
covers that association. Unlocated messages, other provider turns and the current
native command remain. Server, SQLite and browser projections share these rules;
plans, tools, tasks, pending input and attachment ownership follow the selected
turns. The WebSocket protocol advances to 38 so older clients cannot apply native
rewinds as a prefix truncation.

The commit transaction pauses queued prompts for review and retains any existing
user/environment pause. Migration 128 stores retired native turn identities;
late checkpoints, messages and tool updates cannot resurrect those turns, including
after restart. The projection replay also repairs these retirement receipts. Indexed
lookups apply only to threads with native reconciliation history. The orchestration
rendezvous bounds pending work at 64, concurrent handlers at eight and acknowledgement
at ten seconds. Its scope-owned fibers wait for cancellation cleanup; deadline tests
also cover a pinned Effect race-helper cancellation issue without changing Effect.

Focused validation currently passes 124 server cases across six files, 33 browser
store unit cases and 30 shared projection/input cases. The persisted engine fixture
also verifies exact user-message removal and late-checkpoint refusal after restart.
Required full-gate and final production results are recorded below once complete;
no Pi record is promoted by these partial implementation checkpoints.

Final production validation for this continuation passes on the built Node server,
SQLite and Chromium with protocol 38: three user prompts use one Pi child, native
rewind removes the second prompt/reply, the first turn and current command remain,
no fork/additional prompt occurs, the queue is empty and paused for review, and no
page errors occur. The new engine regression uses real turn-start commands with
null-turn user messages and verifies persisted restart plus late-checkpoint refusal.
All eight workspace typechecks and all five build tasks pass. The formatter and
lint pass. The required full run was repeated after the prompt ownership correction and
still stops on the same two migration process-identity cases (330 scripts pass);
Turbo interrupts the remaining workspaces before the exhaustive Git stage. No
process-identity check or release gate was weakened. Independent server and Git
matrix results follow once those complete.

The independent server run completes with 5,390 passing cases and 12 skipped.
Alongside the three existing launcher-identity failures, it caught a missing purge
policy for the new retirement table. That table now has an explicit bounded deletion
handler, preserving retirement receipts until permanent thread purge. Its existing
schema-coverage regression and storage suites are rerun below; this failure is not
classified as environmental.

The purge-policy correction passes all 93 storage/cleanup tests, the formatter,
lint and all eight typechecks. The preceding complete server run exercised 539
files; its additional purge-policy failure is now covered by that passing targeted
run. The three launcher process-identity failures remain unresolved host restrictions.

The exhaustive real-Git matrix passes all 165 cases after native reconciliation.
Nineteen Pi records now carry the continuation/rewind implementation SHAs and exact
file evidence. Their deferred dispositions and coverage are unchanged.

## Agents verify-first: model and effort propagation (15r; audit ongoing)

The older-turn count scenario (#20785) is already handled by F5's independent
Agents panel: its model uses durable work from all turns rather than the active
turn's roster. A new fixture confirms both older live work and current live work
remain counted. Baseline implementation provenance is `848bc1063123` for the panel
model and `8498153f6ed9` for durable background-work lifecycle handling.

The effort scenario (#17496) reproduces in F5: a native Agent launch requested low
effort, but its task-start event omitted it. That fixture fails before this change
and passes after it. The adapter now records bounded launch metadata, uses the
reported child model before resolving nested Agent calls, and inherits the owner's
launch effort. An explicit native selection overrides the parent's current setting;
unsupported effort is hidden for that model while raw launch metadata remains
available for nested inheritance. Configured subagent model defaults apply only
when the Agent call does not explicitly select `inherit`. Private child output
continues to stay out of the parent's conversation.

Runtime events, resume cursors and migration 129 preserve effort through durable
background-work snapshots. Heartbeats preserve it; an actual model change without
compatible effort clears it. The Agents details panel displays the agent's effort
beside its own model. The migration preserves old metadata, tolerates an already
present column and bounds the stored value.

Focused validation passes 315 server cases in six files, 13 web unit cases and all
11 Agents panel Chromium cases, including the visible effort metadata. Broader
validation and the remaining per-SHA audit follow; these checks do not close the
remaining Agents audit, the mandatory verify-first cut line or the catch-up plan.

Source inspection closes two 15r scope exclusions: #15334 changes only the
upstream Lineage relationship view and its child-thread activity model; #15016
changes only the relay's subagent tombstone publisher. Those paths are explicitly
excluded by the approved F5 architecture. Their individual records now say why
and the classification regression pins both decisions. The Copilot ACP routing
commit remains under review because its provider changes need separate scrutiny;
a mobile-labelled details commit also touches shared/web display code. Neither
is discarded from review merely because of its title.

The latest five-task build and all eight typechecks pass. The built Node/SQLite/
Chromium Pi rewind regression also passes after migration 129: one child, three
intentional prompts, no fork or extra prompt, exact abandoned-message removal,
an empty paused queue and no browser errors. The required full run still stops
on the two existing scripts process-identity cases (330 pass, contracts 227 pass);
its failure leaves the release gate closed. The independent server suite reports 5,400 passing cases, 12 skips and only
the three previously recorded launcher process-identity failures caused by the
host denying `/bin/ps`. No other server cases fail. These failures remain release
blockers; the safety checks have not been weakened to bypass the host restriction.

The next native lifecycle reproduction covers #18996 in F5's permission path:
a completed Claude child can leave a question or approval pending when its SDK
abort signal never fires. Both reproductions fail before the fix. Pending requests
now retain the SDK's native agent identity, and either terminal notification
cancels only that child's requests. Parent requests remain pending. Four cases
cover questions and approvals through both `task_notification` and `task_updated`,
including the absence of duplicate resolution during subsequent session cleanup.
The focused adapter/background-work run passes 301 cases; all eight typechecks
and lint pass at that checkpoint. Approval waits also release their abort listener
and handle an already-aborted signal.

The #14980 reproduction likewise fails for both complete and streamed Skill input.
A shared bounded heading helper now supplies the adapter and activity normalization;
new compaction preserves the skill name, and older generic payloads with native
input still present can derive it on read. Existing compact records that already
lost the native input cannot recover an unknown skill name. Validation passes all
288 Claude adapter cases, 47 shared cases, 111 web session-logic cases and a new
Chromium timeline case using persisted generic tool history. The broader verify-first
audit and full release gates remain open.

The #19750 reproduction fails before the restart change: an idle parent with owned
live work receives no marker. Graceful shutdown now records it before stopping the
provider. Two further crash-startup reproductions fail before reconciliation:
restart resume enabled loses the continuation, and disabled resume leaves phantom
Running work. Startup now captures an opt-in marker before retiring unavailable
work as Interrupted; an actually live provider remains untouched. Session identities
include the persisted generation, so the same launch configuration cannot authorize
an older generation's rows. The captured work query is capped at 201 rows and its
count is stored in bounded migration 130 metadata. No private output enters the
continuation. The continuation states that completion was not confirmed and asks
for a current-state check; existing opt-out, pending-input, queued-human-work,
newer-turn, expiry and exactly-once guards remain in force. Workflow-owned and inert
rows do not trigger a second recovery path. Focused validation passes 283 cases;
the overflow fixture and migration bound additionally pass all 86 cases in their
two files. Typecheck, formatter and lint pass.

Two more source-inspected exclusions close #20061 and #19631: the former solely
adopts and orders events for resumed native child threads, and the latter solely
optimizes delegated-completion delivery recovery. Neither subsystem exists in F5.
The renamed-worktree patch stays under review because it also introduces a branch
compare-and-swap condition and shared-checkout behavior.

The required full run passes web (2,346), shared (734; one skip), desktop (570),
contracts (227), effect-acp (21) and marketing (12). It fails the same two scripts
process-identity cases (331 pass), stopping Turbo before server completion or the
exhaustive Git stage. Independent complete server validation reports 5,412 passing cases, 12 skips and
only the same three launcher identity failures. The full gate has not passed
and no waiver is recorded.

The #16151 typography reproduction fails in Chromium: the agent duration uses
JetBrains Mono while its panel uses Inter. Duration now inherits the panel's
text font and retains tabular numbers. All 12 Agents panel Chromium cases pass,
including a computed-font assertion, without changing the panel layout or its
native action ownership.

The #19338 scenario reproduces in F5: after the parent changes model and starts a
later turn, older task progress uses that later turn's ID. Native task events now
retain the launch turn, and bounded resume metadata preserves it across process
replacement. The same fixture verifies that parent model/effort changes and
steering keep the background task and its own model/effort alive in one SDK query.
A second failing-before reproduction shows that session-stop events omit the
stored native run ID; durable run-scoped rows consequently cannot be addressed.
A shared native run-reference helper now carries that identity through progress,
model refinements, both terminal paths and session shutdown, including messages
whose SDK omits a repeated run identifier. Confirmed-stop acknowledgement guards
remain unchanged. All 315 focused adapter/resume/background-work cases, all eight
typechecks, formatter and lint pass at this checkpoint.

The five-task production build also passes after migration 130. The built
Node/SQLite/Chromium Pi regression reports one live child, three intentional
prompts, no extra prompt or native fork, exact native rewind reconciliation,
an empty paused queue and zero browser errors. This checkpoint predates the
subsequent Claude turn/run-ownership fix. It remains fixture-based evidence rather
than installed-Pi account validation. A fresh origin/main fetch confirms that the
review branch is zero commits behind main.

For #19751, source inspection finds that F5's scoped thread MCP transport and
runtime handler have no parent-turn lifetime check. Baseline provenance is
`42d9a5862ed8`. A new native MCP Client/InMemoryTransport/McpServer integration
fixture confirms that access persists on the parent-idle transition, requests
cannot select a different transport thread, and closing the runtime owner revokes
access. All four MCP transport tests pass with all eight typechecks. This transport
fixture does not replace installed-Claude workflow validation.

For #17329, both Muse reproductions fail before the fix: a workflow child's
approval is attributed to the native child-run ID. Such IDs are not F5 parent
turns. The approval now remains on the parent thread without a turn association,
including stage changes, parent completion, response and resolution. Native
requirements and decisions retain their original Muse identifiers. Bounded origin
metadata is validated before use, and malformed stage updates take the existing
fail-closed path. Parent approvals retain their own turn. All 38 Muse adapter,
provider and event-mapping cases, all eight typechecks, formatter and lint pass.
The exhaustive Git matrix also passes all 165 cases at the preceding Claude
lifecycle checkpoint. Per-SHA proofs remain deferred until the full 15r audit closes.

The #15493 reproduction fails in the durable model and Chromium: provider-instance
identity is dropped before rendering, so two configured accounts of one provider
cannot be named. The model now retains that identity and cards resolve the exact
configured instance using the existing cached provider catalog. Removed, unknown,
legacy-unspecified or driver-mismatched instances do not borrow another account's
name. No provider validation or account polling is added. All 13 panel Chromium
cases, nine model cases, all eight typechecks, formatter and lint pass.

The #14999 reproduction fails for `Subagent: /root/coordinator/review_api`.
A shared display utility now produces `Review Api` for native agent titles, while
shell titles and underlying provider identifiers remain intact. Unicode and plain
text cases are included. All eight shared display cases, ten Agents model cases,
all eight typechecks, formatter and lint pass.

Source review of #17134 finds an OpenCode 2-specific scenario: the new
`@opencode/client/effect` adapter joins concurrent `subagent` calls and settles
those calls from `session.inbox.enqueued` reports. F5 uses the classic
`@opencode-ai/sdk/v2` HTTP adapter and its `properties` event stream; its installed
SDK is 1.14.33 and the local supported CLI reports 1.18.32. Its task calls have
no OpenCode 2 inbox/report path. The joined-report settlement scenario is therefore
not applicable to this supported protocol. This individual classification does not
discard other OpenCode fixes or add OpenCode 2 support.

The mixed Copilot #17714 patch needs an F5 adaptation even though native child
threads are excluded: its attributed child text, reasoning and tools reproduce in
F5's parent stream. The local Copilot ACP runtime now subscribes to the five raw
attribution events and filters private frames on the ordered wire reader, before
text coalescing. Public parent text is retained even when it is byte-identical to
a child's chunk. Other configured executables retain their existing capabilities.
Ownership is session-scoped, bounded and cleared on disposal; late child tools
remain private after a terminal raw event. Unattributed chunks cannot prove parent
ownership while native children are active. Filtered activity still advances native
resume-replay liveness. A real stdio fixture fails before the change and passes in
both hardening modes. All 68 focused ACP tests, all eight typechecks, formatter and
lint pass. Native task-card lifecycle and installed-Copilot workflow validation
remain review obligations; this is partial evidence, not a completed 15r claim.

Source inspection also finds that the shared ACP protocol retains an unbounded
raw notification copy alongside reliable typed delivery. The session wrapper never
exposes that diagnostic stream. It now drains the copy in its own scope so the
new feed does not accumulate those frames; the callback delivery path is preserved.
The same real-transport suites verify notification delivery and process disposal.
This is structural retention evidence, not a retained-heap benchmark result.

Source inspection closes #15281 as a native-child-thread UI exclusion. Both runtime
files add and render `SubagentNotificationLink`, resolving the parent's projected
child-thread record and linking to that child. F5 has no such notification source,
child-thread projection or native subagent navigation. Its independent Agents
panel retains completed work through its existing lifecycle instead.

At the preceding names checkpoint the complete server suite reports 5,418 passing
cases, 12 skips and only the three known launcher identity failures. The required
full run passes shared (742; one skip), desktop (570), effect-acp (21) and marketing
(12), then fails the same two scripts identity cases (332 pass) and interrupts the
remaining workspaces. The five-task build and fresh built Node/SQLite/Chromium Pi
rewind regression pass: one child, three intentional prompts, no extra prompt or
fork, exact reconciliation, an empty paused queue and no browser errors. This
checkpoint predates the subsequent Copilot change. Required release gates and
the full catch-up remain incomplete.

At the Copilot checkpoint, the complete server suite reports 5,433 passing cases,
12 skips and the same three launcher process-identity failures. The required
`test:full` attempt fails the same two scripts recovery identity cases (332 pass),
before reaching the exhaustive Git command. The current six-task production build
passes. No process-identity safeguard is bypassed, and the required full gate is
still unmet.

A subsequent 15a source pass reads 36 small compiler candidates individually.
Thirty-three qualify for the plan's compiler/test maintenance exclusion; each
record now states the exact code-shape change, with a source-review table in the
classification document. Three patches with error-cleanup or closure-retention
behavior remain open. These are classification decisions, not runtime ports or
performance claims. The strict ledger check and all 12 October/September plan tests
pass: 4,084 records, 1,283 planned, 482 ported, 152 equivalent and two already
present. The interval and frozen September memberships are unchanged.

Verify-first #15515 reproduces in F5's shared ACP transport. Sixteen of 22 initial
cases fail before the change: a handler defect or construction throw can stop the
wire reader, skip later notification handlers or emit a connection-wide defect.
The shared handler boundary now catches construction and Effect defects, logs the
failure and isolates the originating call. Typed request errors retain their
classification; cleanup defects take precedence over a typed failure. Notification
failures cannot skip subsequent subscribers. Owner interruption still cancels
notification, extension and core handlers, and explicit completion signals verify
that their finalizers finish. An unexpected reader defect fails pending requests
and rejects later calls with the same connection failure instead of hanging.

The complete ACP library suite passes all 53 cases, including 32 new isolation and
cancellation cases. Six server ACP suites pass 68 cases over the real stdio
fixtures. Two new real-WebSocket cases confirm that F5's existing request-local
exit handling already preserves concurrent and subsequent requests after a route
defect or construction throw; the held request completes after explicit release.
The WebSocket baseline comes from `d4d6991e764631bc825a3e4061651d6ff1ab484f`.
All eight typechecks, formatter, lint and whitespace checks pass. The ledger records
this individual implementation proof while keeping the broader 15a audit and
required release gates open. This correctness fix makes no CPU performance claim.

After the RPC isolation change, the complete server suite passes 5,435 cases and
skips 12; only the same three launcher process-identity cases fail. The required
full run again fails the two scripts process-identity recovery cases (332 pass),
so its exhaustive Git phase is not reached. The six-task build passes, and a fresh
built Node 26.12.0/SQLite/Chromium Pi rewind regression passes on protocol 38: two
native assistant messages, one live child, three intentional prompts, no extra
prompt or fork, exact rewind reconciliation, an empty paused queue and zero page
errors. The new fixture root is `/tmp/f5-pi-production-bq19g4pc`. This exercises a
real process and browser with the deterministic Pi fixture, not an installed Pi
account. Required release gates remain open.

The next 15a source pass reads 40 additional full compiler patches and records 31
further code-shape exclusions, each with an individual result. Nine patches with
save/error cleanup, state timing, late theme adoption, retry fencing or SSH-specific
behavior stay open for runtime/subsystem review. The strict ledger and all 12 plan
tests pass with 1,252 planned records; no delivery dispositions are promoted.

Pi #16210 reproduces in the shared title path: five cases fail before the fix,
including the real metadata process receiving no linked PR context. The title
contract and all provider prompt paths now preserve that context. ProviderCommandReactor
reads the thread's five most recent saved links through a shared projection reader,
which PR Hub also uses. Lookup is asynchronous and best-effort with a short timeout;
it adds no forge/account probe and does not block the provider turn. Labels and
prompt context are bounded separately, JSON-quoted and marked as untrusted
reference data. Invalid persisted links cannot become prompt context and do not
prevent ordinary title generation.

The 12 focused suites pass all 205 cases, covering Pi's process, Codex's stdin,
Muse's shared factory, the other generation backends, exact thread ownership and
link limits, corrupt data, and asynchronous title generation while a turn runs.
All eight typechecks, formatter, lint and whitespace checks pass. Implementation
proof is attached to #16210 without promoting the remaining Pi phase or release
obligations. Installed Pi account validation remains pending.

A third compiler pass reads 25 additional full patches and closes 16 mechanical
cases, retaining nine mixed runtime patches. Across the three passes, 101 complete
patches have been inspected and 80 individually documented as compiler/test
maintenance. Full source inspection separately closes two excluded device UI
patches (#20488, #20489) and the excluded native SSH password-dialog patch (#20490).
Their runtime cleanup differences are not labeled behavior-neutral. The strict
ledger and plan tests continue to protect the pinned interval and carrier sets.
A fresh origin fetch also confirms no commits behind origin/main.

At the linked-title checkpoint, the complete server suite reports 5,443 passing
cases, 12 skips and the same three process-identity failures. The latest required
full run fails the same two scripts recovery identity cases (332 pass), before the
Git matrix. The strict ledger and 12 plan tests pass after the compiler/device/SSH
triage: 4,084 records, 1,233 planned, 482 ported, 152 equivalent and two already
present. None of these outstanding full-gate failures is waived.

The fourth compiler pass reads 39 complete patches, closes 26 mechanical cases
and four excluded-subsystem cases, and retains nine mixed runtime obligations.
Across the four passes, 140 full candidates have been inspected: 106 mechanical
exclusions, seven subsystem exclusions and 27 retained runtime cases. Thirty-three
larger compiler candidates still need source review. The strict ledger reports
1,203 planned entries, and the combined plan/performance-fixture tests pass 29 cases.

The current server-component measurement completes five warmups and 30 measured
repetitions for all eight workloads, with no failed resource observations. The
source is clean commit `62a7ebf2f4279ef48ecffc8253efe3d1fa3d3a69`; raw report:
`/tmp/f5-october-runtime-server-20261020.json`. Stream latency is 55.97 ms p50 and
75.71 ms p95; event-loop delay is 14.64 ms p99. Read-model retained heap is 51,890,608
bytes and RSS is 229,031,936 bytes. These are current-checkpoint absolute results,
not a baseline comparison or complete interactive/soak evidence.

The first interactive attempt fails before the soak because the wire fixture
predates three renderer queries. Its generic unknown response is interpreted as
a workspace transition, causing the missing-phase render error. A failing-before
schema test reproduces this fixture drift. The fixture now supplies valid idle
worktree state, a null transition and an empty PR-watch list; unknown queries still
fail the completeness assertion. Duplicate pre-existing switch cases are removed.
All 17 performance-support tests, all eight typechecks, formatter and lint pass.
The real browser smoke now completes with no unknown methods or page errors and
passes its transport/input/switch bounds. Smoke has no retained-memory credit.
Both full reports will be rerun against the same updated fixture and source.

The fifth compiler pass reads 26 more complete patches, closes 13 mechanical cases
and retains 13 mixed runtime obligations. Across five passes, 166 complete patches
have been read: 119 mechanical exclusions, seven subsystem exclusions and 40
retained runtime cases. Seven larger patches remain partially inspected. The
classification changes reduce planned entries to 1,190 without promoting any
runtime delivery disposition.

The refreshed server baseline runs all eight workloads with five warmups and 30
repetitions on clean commit `bd5bc8bc1b21649259fdb1ba02880dc4ec62d2c4`.
[Its raw report](./upstream-october-server-baseline-20261020.json) passes every
resource observation: stream p95 is 77.04 ms and event-loop p99 is 14.89 ms.
The matching browser attempt completes all latency samples and 11 memory samples
across ten minutes. [The browser diagnostic](./upstream-october-browser-soak-diagnostic-20261020.json)
preserves those samples and fixture counters. All six retained-memory bounds pass;
server heap grows 146,336 bytes over the final five minutes. The fixture consumes
120,750 delivered stream updates at 20.003 updates/s/thread, with no unknown RPCs.
However, the full interactive command **fails** its native process-activity check:
59,592 terminal data events but zero activity events, against a required minimum
of 20. The host also rejects `/bin/ps` with operation-not-permitted. The activity
failure is consistent with that restriction but is not independently diagnosed.
No complete interactive report or successful coverage certification is claimed;
no guard is relaxed, and no measurements are reconstructed as a successful report.

The streamed-thread scenario #18890 reproduces: the valid failing-before test
observes seven full metadata reads during a short message/activity sequence.
`1338d41a6c` introduces repository operations that read only token-accounting state
and patch only timestamps/estimates. The regression retains a large task payload
byte-for-byte, preserves other thread ownership, refuses missing-thread insertion,
keeps reasoning status from updating activity, and checks nullable versus omitted
estimates. Compaction retains its existing full metadata update. All 194 focused
server cases and all eight typechecks pass; formatter and lint pass (29 warnings,
zero errors). The six-task production build passes. This is implementation proof;
comparative performance acceptance remains pending.

The same checkpoint strengthens the existing #19317 baseline proof. Each of three
cases sends 100 proposed-plan deltas and waits for a later projected marker before
checking event counts: zero proposal writes before completion, one exact complete
plan on success, and zero on interruption/failure. F5's buffer-until-completion
behavior originates in `8168bd456ae23521e21bf68b08d0d860a6abd901` and is preserved.
No redundant runtime coalescer or CPU improvement is claimed. Both per-SHA ledger
records retain their planned disposition until the 15a audit and gates close.

The required full run after this change again fails the same two scripts recovery
identity cases, with 333 passing scripts cases. It does not reach the exhaustive
Git matrix. No waiver or permission bypass is applied.

The complete server suite after `1338d41a6c` passes 5,443 cases and skips 12;
only the same three launcher process-identity cases fail. The subsequent clean
server measurement on `cd03f2c2b7b3aee196cffdee12651199a71c1c9f` completes five
warmups and 30 repetitions with every absolute resource observation passing.
[The first candidate report](./upstream-october-thread-activity-first-candidate.json)
is preserved. However, comparison with the saved baseline fails: replay p95 is
331.79 ms versus 291.76 ms, crossing the latency regression rule, and streaming
CPU p95 is 679.16 ms versus 671.05 ms, missing the required 20% improvement.
Projection statements decrease from 3,812 to 3,681 and total statements from
7,288 to 7,157. This is not accepted comparative performance evidence; the failed
result is retained while the remaining live projection overhead is investigated.

Investigation of that first comparison finds a further F5-specific live-projection
cost: each event advances 19 cursors through separate projector operations. A new
failing-before reproduction also shows that a late cursor failure leaves an earlier
message committed when the pipeline is called directly outside the engine's outer
transaction. `01a72d7ec4` now applies one live event and all cursor advances in one
transaction, issuing one validated cursor upsert statement. The regression verifies
complete rollback, unchanged cursors, successful retry and all 19 cursors advancing
to the event sequence. Per-projector bootstrap batching retains its prior behavior.
Shared helpers keep failure logging and attachment side-effect handling consistent.
All 222 focused projection/ingestion/engine cases, all eight typechecks, formatter,
lint and the six-task production build pass. Comparative acceptance remains open.

A fresh built Node 26.12.0/SQLite/Chromium regression using the deterministic Pi
fixture passes on protocol 38: two native assistant messages, one live child,
three intentional prompts, exact native rewind reconciliation, zero queued items,
a paused queue and zero page errors. The root is `/tmp/f5-pi-production-_u35qc92`.
It adds no installed Pi/account proof. The required full run still fails only the
two scripts process-identity cases (333 pass); web passes all 2,349 tests, shared
passes 742 with one skip, and desktop passes 570 before the root run stops.

The complete server suite after atomic live projection passes 5,444 cases and
skips 12. Only the same three launcher process-identity cases fail. The strict
ledger and all 12 September/October plan tests pass with 1,190 planned entries;
the source audit and required release gates remain open.

The subsequent server measurement runs alone on clean
`fbbc374dd2ed3204913a54d396da49f05f0c22ad` with the unchanged fixture, harness and
runtime. [Its raw candidate report](./upstream-october-live-projection-server-candidate.json)
passes comparison against the [saved baseline](./upstream-october-server-baseline-20261020.json),
including the named `orchestration.assistant-stream` CPU target. Both reports use
five warmups and 30 measured repetitions. Streaming CPU p95 falls from 671.045 to
509.680 ms (24.05%); wall p95 falls from 1,093.304 to 920.932 ms (15.77%). Projection
SQL statements fall from 3,812 to 1,107, and total statements from 7,288 to 2,009.
Per-delta p95 falls from 77.036 to 65.749 ms. Every absolute bound passes and no
workload crosses the latency regression rule; replay p95 is 298.739 ms versus
291.758 ms (2.39%). The first failed candidate remains preserved above. This is
accepted server-component evidence for the incremental projection change, not a
comparison against original main or successful full interactive coverage. The
native terminal activity guard, required full gate and remaining 15a audit remain
open, and no delivery disposition is promoted.

The #16682 source audit finds an existing F5 coalescer rather than the upstream
per-chunk persistence behavior (`abdf16fd7c`). Ten new regressions nevertheless
fail against that baseline: meaningful status/title changes without detail,
structured output and periodic argument/diff progress are lost. The final baseline
run records ten failures out of 34 cases; two additional positive omitted-kind
placeholder cases are then retained. In both real ACP modes, the baseline emits
only three of 17 required tool updates.

`ae320efe8e` preserves meaningful lifecycle/title/structured output immediately,
samples argument and diff changes every ten updates, and skips identical cloned
snapshots using value comparison without serializing their contents. The shared
presentation rules derive generic titles, so empty placeholders stay hidden even
when the native provider omits kind. The original placeholder integration test
and the 1,000-redraw regression (114 emitted events with bounded payloads) stay
intact. Two real-process cases each exercise two turns, both hardening modes,
ordered event barriers and exact final arguments/output; each turn emits 17 tool
updates from 125 native tool frames. All 208 focused ACP/adapter cases pass with
three existing skips, and all eight typechecks, formatter and lint pass. The
six-task production build passes. The required full run still fails the same two
scripts recovery identity cases. This adds bounded event-count/correctness proof;
it does not claim measured CPU improvement or reproduce the upstream storage
flood. The per-SHA record stays planned until the remaining audit and gates close.

The complete server suite at the ACP checkpoint passes 5,462 cases and skips 12;
only the same three launcher process-identity cases fail. The strict ledger and
all 12 September/October plan tests pass. Required full/native gates remain open.

The individual #18378 audit confirms that F5's Node 26.12.0 built-in fetch
(undici 8.11.2) negotiates HTTP/2 against a real local TLS endpoint before the
change. `0d0711a665` installs an HTTP/1.1 dispatcher before server startup only
when bundled undici is at least version 8. It lazy-loads the exact upstream-pinned
8.11.2 dependency, retains Node's environment proxy choice and credentials, and
initializes once. Executable-relative resolution and external staging cover the
standalone layout. No global exception handler or swallowed crash is introduced.
The [upstream idle-reaper issue](https://github.com/nodejs/undici/issues/5936)
has no deterministic panic reproducer; this evidence establishes the exposed
negotiation path and its removal, not a reproduced native panic.

All nine child-process/TLS tests, the external staging test, formatter, lint,
all eight typechecks and the six-task production build pass. Both ESM and CJS
production entries start successfully. A real Node 26.12.0 single executable
also starts with an empty PATH and executable-relative dependencies supplied
from the checkout. The diagnostic first required thinning the universal macOS
Node executable and staging the server workspace's dependencies; its initial
help-text assertion expected the wrong capitalization and was corrected after
inspecting the successful output. This is a standalone resolution smoke, not a
built release archive with independently installed dependencies. The required
full run still fails the same two scripts process-identity recovery cases
(333 pass), before reaching the exhaustive Git matrix. The per-SHA record stays
planned while the remaining 15a audit and required release gates remain open.

## fff-node 0.11.0 upgrade blocked by endpoint security (15a; deferred)

The `@ff-labs/fff-node` 0.11.0 upgrade (#14543, #18514) is deferred. On this
host, Cortex XDR stops `bun add --cwd apps/server --exact @ff-labs/fff-node@0.11.0`
after the packages are downloaded and extracted and before the lockfile is saved.
It also terminates the terminal process tree that launched the install. Four
attempts failed the same way, and `@ff-labs/fff-bin-darwin-arm64@0.11.0` never
reached Bun's global cache. Other dependency additions in this worktree
(`undici`, `parse5`) completed normally.

The suspected file is the 0.11.0 `libfff_c.dylib`, sha256
`d052aae92b8d89f4734399aa53f80a327c4931f1b5dea0a7d96f9c488229ba43`. It is ad-hoc
signed with a valid signature, and links the same system libraries as 0.9.4.
This is probably a false positive, but the Cortex security event has not been
inspected. The worktree was restored to the locked 0.9.4 install with
`bun install --frozen-lockfile`. Both content-search suites pass on 0.9.4
(11 tests). Do not retry the install from inside F5. Retry only after a security
review clears the package, and from a terminal that does not host F5.

## Agent exit without a terminal event (15a, #19131)

Upstream fails a run whose provider stream ends without a terminal event. In F5
the equivalent boundary is per session: an agent process that dies mid-turn
must still produce `turn.completed` or `session.exited`, because those are the
only events that settle the active turn. Claude, Codex, OpenCode, Pi and Muse
already do. Existing Claude and Codex tests cover a stream abort and an
app-server exit. OpenCode, Pi and Muse route stream failure or host exit
through their error stop paths.

The ACP adapters did not. Their ACP event stream never ends on its own, so a
Cursor, Grok, Antigravity or custom ACP agent that exited during
`session/prompt` left the session registered as live with a stale active turn.
Its prompt failed, but no terminal event followed, and every later message was
sent to the dead process and failed with "ACP process exited". F5 never
replaced the session because the adapter still reported it.

`AcpSessionRuntime` now exposes `awaitExit`, backed by the child's exit code.
`CursorAdapter` and `GrokAdapter` watch it. On an exit they did not request,
they fail the unfinished turn and stop the session with an error-kind,
recoverable `session.exited`. The next send then starts a fresh session.
Requested stops mark the session stopped first, so they are unaffected.
`GrokAdapter` records the turn it last completed, because its active turn id
survives completion and its prompt count may already have dropped when the
exit is observed.

The mock ACP agent gained `T3_ACP_EXIT_DURING_PROMPT`. A Cursor test and a
Grok test each failed before the change (no `turn.completed` for the turn) and
pass after it. All Cursor and Grok adapter tests (33), the ACP, custom ACP,
provider-service and runtime-ingestion suites (454 passed, 3 skipped) and all
eight typechecks pass. Typechecking caught `Effect.forEach(..., stopSessionInternal)`
call sites that would have passed the element index as the new exit argument;
they now call it with the session only. The complete server suite passes 5,471
tests with 14 skipped; it still fails only the three known `launcher.test.ts`
process-identity cases that need `ps` access this host denies.

## 15a triage log

Each decision updates the October plan artifact and the ledger together, so
reapplying the plan keeps it. Reasons name the upstream paths that were
inspected.

**Batch 1 (63 records, not applicable).** 17 change subsystems f5 does not
have: upstream's release jobs (npm platform packages, Vercel, Windows
packaging order), the relay and T3 Connect, the mobile app and its bounded
snapshot endpoint, device hosts and simulators, multi-machine settings and
scheduled tasks. 46 are React Compiler adoption commits confined to
`apps/web` (allowlist entry plus removal of manual memoization), which the plan
classifies as maintenance. Six compiler-motivated refactors that also change
ref or effect timing stay planned for individual review, as do the named 15a-3
render fixes.

**Batch 2 (server streaming, 6 records).** Five earlier f5 commits already
delivered these upstream fixes, so they are now recorded as ported or
equivalent with their f5 commits:
[t3code#16682](https://github.com/pingdotgg/t3code/pull/16682) (ACP tool
redraw coalescing), [t3code#18890](https://github.com/pingdotgg/t3code/pull/18890)
(streamed events patch activity columns),
[t3code#18378](https://github.com/pingdotgg/t3code/pull/18378) (startup fetch
stays on HTTP/1.1), [t3code#15515](https://github.com/pingdotgg/t3code/pull/15515)
(request-local ACP handler failures) and
[t3code#19317](https://github.com/pingdotgg/t3code/pull/19317) (Codex plan
deltas buffered until completion).
[t3code#15048](https://github.com/pingdotgg/t3code/pull/15048) targets
upstream's orchestration-v2 outbox. It is equivalent because f5 has a single
serialized engine worker that publishes in commit order, pauses the queue on
checkpoint revert and keeps durable terminal receipts.

**Batch 3 (terminal history, 4 records).**
[t3code#17183](https://github.com/pingdotgg/t3code/pull/17183) is ported:
history flushes every 250 ms instead of 40 ms. A new test failed before the
change. [t3code#17181](https://github.com/pingdotgg/t3code/pull/17181) and
[t3code#17179](https://github.com/pingdotgg/t3code/pull/17179) are equivalent:
each f5 terminal persists on its own chain with a timer that new output never
resets, and history appends never parse escape sequences.
[t3code#17178](https://github.com/pingdotgg/t3code/pull/17178) adds an observe
RPC to upstream's terminal output window, which f5 does not have.

**Batch 4 (idle polling, 5 records).**
[t3code#16771](https://github.com/pingdotgg/t3code/pull/16771) is equivalent.
f5's status refresh runs `status` plus `diff-files`/`diff-index` plumbing and
never adds untracked files to a temporary index. Only an explicit review diff
does that, and it is capped at 512 paths. Not applicable:
[t3code#19399](https://github.com/pingdotgg/t3code/pull/19399) (resource
telemetry process sampler),
[t3code#16206](https://github.com/pingdotgg/t3code/pull/16206) and
[t3code#14893](https://github.com/pingdotgg/t3code/pull/14893) (project
enrichment refresh), and
[t3code#13689](https://github.com/pingdotgg/t3code/pull/13689)
(RepositoryIdentityResolver TTL). f5 resolves favicons and repository identity
on request, and its PR watch sweep polls only watched pull requests.

**Batch 5 (server reads, storage and lifecycle, 15 records).** Five ports,
each with a test that failed before the change where behavior was observable:

- [t3code#19429](https://github.com/pingdotgg/t3code/pull/19429): a
  `tool.updated` activity that repeats the last one stored for its item is
  skipped (f5 has no execution-node table, so this is the matching write).
- [t3code#13688](https://github.com/pingdotgg/t3code/pull/13688): shutdown
  rewrites only the bindings it stops.
- [t3code#19305](https://github.com/pingdotgg/t3code/pull/19305): bindings
  over 64 KiB use a throwaway statement. The values path also stops ignoring
  `SafeIntegers`, which was a separate f5 bug the upstream test exposed.
- [t3code#13720](https://github.com/pingdotgg/t3code/pull/13720): the
  projector patches a copy of the thread list instead of mapping it.
- [t3code#13774](https://github.com/pingdotgg/t3code/pull/13774), reaper half:
  sweeps filter stopped bindings in SQL.

Equivalent: [t3code#17029](https://github.com/pingdotgg/t3code/pull/17029)
(EXPLAIN QUERY PLAN shows f5's tail pages as index-ordered, LIMIT-bounded
searches), [t3code#17041](https://github.com/pingdotgg/t3code/pull/17041)
(replays resolve through the receipts primary key),
[t3code#19316](https://github.com/pingdotgg/t3code/pull/19316) and
[t3code#16652](https://github.com/pingdotgg/t3code/pull/16652) (stored tool
activities never keep raw provider data, and the patch is stored once), and
[t3code#12600](https://github.com/pingdotgg/t3code/pull/12600) (positive
resolutions already cached for 5 seconds).
[t3code#13693](https://github.com/pingdotgg/t3code/pull/13693) is declined:
f5's second snapshot decode fills schema defaults, and removing it failed the
hydration test. [t3code#19226](https://github.com/pingdotgg/t3code/pull/19226)
is deferred because its reader worker is out of scope for this round.
[t3code#13504](https://github.com/pingdotgg/t3code/pull/13504),
[t3code#19386](https://github.com/pingdotgg/t3code/pull/19386) and
[t3code#14475](https://github.com/pingdotgg/t3code/pull/14475) change
upstream mechanisms f5 does not have.

Found while testing: five tests in
`apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts` use plain
`it(...)` with an Effect body inside `it.layer`, so their bodies never run.
Run as `it.effect`, two of them fail. This is not fixed here.

**Batch 6 (platform and upstream-only server subsystems, 15 records).**
[t3code#19966](https://github.com/pingdotgg/t3code/pull/19966) and
[t3code#17384](https://github.com/pingdotgg/t3code/pull/17384) are ported in
one change: the desktop marks the backend environment as prepared, and the
server stops repeating the login-shell or PowerShell PATH probe. This was not
run on Windows. [t3code#18519](https://github.com/pingdotgg/t3code/pull/18519)
is equivalent, because f5 already kills the Windows terminal tree without a
grace wait. The rest change subsystems f5 does not have: the node-pty 1.2
beta upgrade, preview picture-in-picture, ignored labels on folder listings,
port polling, resource telemetry, the service launcher, the relay, and five
`orchestration-v2` paths.

**Batch 7 (client-side and remaining shared items, 12 records).** Two ports,
each with a test that failed first:
[t3code#15520](https://github.com/pingdotgg/t3code/pull/15520) renders
`[label](<path)` file links whose `>` never arrived, done as a remark plugin
on f5's existing markdown tree. The sidebar part of
[t3code#15666](https://github.com/pingdotgg/t3code/pull/15666): f5's sidebar
polls git status per worktree only to show the branch's PR, and those polls
no longer fetch from the remote. Eight items change upstream subsystems f5
does not have: inline-code file chips, effect RpcClient streams, the client
trace and its proxy, the client snapshot cache, repository identity refresh,
the model manifest, and a multi-environment setting. Two move to their
feature workstreams:
[t3code#16816](https://github.com/pingdotgg/t3code/pull/16816) (shared model
favorites) to 15k and
[t3code#18740](https://github.com/pingdotgg/t3code/pull/18740) (revealing
running terminals) to 15p.

**Batch 8 (web rendering and terminal, 13 records).** Four ports.
[t3code#18387](https://github.com/pingdotgg/t3code/pull/18387) replaces the
backtracking markdown link regex with a single linear scan, checked for parity
against the old regex on 2,000 generated strings.
[t3code#18420](https://github.com/pingdotgg/t3code/pull/18420) sorts diff
files with shared collators instead of building one per comparison.
[t3code#13408](https://github.com/pingdotgg/t3code/pull/13408) drops a
trailing colon from terminal path links (5 new tests failed first).
[t3code#17658](https://github.com/pingdotgg/t3code/pull/17658) keeps the
terminal drawer's stored height when the window shrinks: f5 synced the
window-capped height back as the preference, so the drawer stayed short after
the window grew again. One is equivalent:
[t3code#19395](https://github.com/pingdotgg/t3code/pull/19395) removes a
resize debounce f5 never had. Eight change things f5 does not have: the
held-modifier shortcut hints, the composer banner's sibling `:has()`
selectors, timeline prepending, the live-activity shimmer, background
terminal drawers (f5 mounts only the open drawer of the active thread), and
three Ghostty renderer changes (f5 uses xterm.js). The four new reason keys
use the `upstream-only-subsystem:` prefix, because the plan validator accepts
only that prefix outside its fixed key list.

**Batch 9 (settings, 18 records).** One port:
[t3code#17859](https://github.com/pingdotgg/t3code/pull/17859) makes Cmd/Ctrl+F
focus the settings search. Before, it did nothing there, because only the chat
view handles `chat.find`. One is equivalent:
[t3code#20764](https://github.com/pingdotgg/t3code/pull/20764) persists the
clamped search highlight, which f5's settings search already does. Four are
compiler-motivated refactors or compiler workarounds that f5 does not need: its
settings are not compiled, and none of the four changes behavior. Twelve change
upstream pieces f5 does not have:

- the `preview.focusUrl` label
- the licenses page
- the project-group settings hook
- the SnapShot coordinator
- dynamic Lucide project icons
- the client snapshot cache
- multi-environment setting writes
- the Connections panel widths
- ChatCanvas measurement
- the client connection registry
- the local font picker
- the shortcut recorder (f5 takes shortcuts as typed text)

**Batch 10 (web behavior fixes, 14 records).** Six ports, each with a test:

- [t3code#19722](https://github.com/pingdotgg/t3code/pull/19722): when the
  saved text generation model left the catalog, f5 fell back to the flagship
  chat model. It now tries the driver's cheap text generation default first.
- [t3code#17652](https://github.com/pingdotgg/t3code/pull/17652): a wheel over
  the turn rail or the minimap now scrolls the chat. Both float beside the
  scroll container, so before this the wheel scrolled nothing.
- [t3code#12962](https://github.com/pingdotgg/t3code/pull/12962): running
  terminal icons in the sidebar pulse in step and respect reduced motion.
- [t3code#18494](https://github.com/pingdotgg/t3code/pull/18494): model picker
  search keeps the provider's newest-first order among equal matches. The
  shared `scoreQueryMatch` gains an opt-in `ignorePosition`; other callers are
  unchanged.
- [t3code#15152](https://github.com/pingdotgg/t3code/pull/15152): the model
  picker fits short lists instead of always rendering at its 384px cap.
- The terminal drawer half of
  [t3code#17657](https://github.com/pingdotgg/t3code/pull/17657): a drag writes
  the height to the drawer directly and commits once on release. Its new
  browser test also covers batch 8's
  [t3code#17658](https://github.com/pingdotgg/t3code/pull/17658), and both
  cases failed on the old drawer.

Four are equivalent:
[t3code#19312](https://github.com/pingdotgg/t3code/pull/19312) (f5 never
re-reads storage on write),
[t3code#11337](https://github.com/pingdotgg/t3code/pull/11337) (f5 never moves
the editor caret from the answer handler),
[t3code#15394](https://github.com/pingdotgg/t3code/pull/15394) (f5 already
removes an action's old keybindings on every save), and
[t3code#17396](https://github.com/pingdotgg/t3code/pull/17396) (update
settings are already searchable).
[t3code#17659](https://github.com/pingdotgg/t3code/pull/17659) is deferred,
because f5's sidebar width guards measure by writing the app-wide
`--sidebar-width`. They would break if drags stopped writing it, so the guards
need reworking first. Three are not applicable: the floating header toggles and
the docked thread details card (two records) do not exist in f5.

**Batch 11 (15a-3 render isolation, 17 records).** This batch meets the 15a-3
structural acceptance. With the timeline and composer wrapped in React
Profiler, ChatView browser tests count zero commits for another thread's
token, an equal provider snapshot, an unrelated settings write, typing in the
composer and a right panel toggle. They also count zero timeline commits when
an image preview or a dialog opens. Five ports, each with a test that failed on
the old code:

- [t3code#20848](https://github.com/pingdotgg/t3code/pull/20848): a settings
  write re-renders only readers whose selected value changed. The conversation,
  root route, sidebar, command palette, diff panel and always-mounted
  controllers select their fields through `useAppSettingsSelector`, and writers
  use `updateAppSettings` without subscribing.
- [t3code#20853](https://github.com/pingdotgg/t3code/pull/20853): streamed
  tokens no longer re-render the right panel tab strip, which is now memoized
  with stable handlers.
- [t3code#18077](https://github.com/pingdotgg/t3code/pull/18077): opening or
  closing a right panel no longer re-renders ChatView and the composer.
  ChatView is memoized, and the header subscribes to its own toggle states.
- [t3code#20837](https://github.com/pingdotgg/t3code/pull/20837): router
  updates no longer re-render the sidebar and chat layout, which now read the
  location when their settings action fires.
- [t3code#15266](https://github.com/pingdotgg/t3code/pull/15266): command
  palette results are virtualized. Keyboard navigation reaches unmounted rows,
  and Enter runs the highlighted item even when its row is not mounted.

Five are equivalent:
[t3code#20823](https://github.com/pingdotgg/t3code/pull/20823) (the root and
open panels ignore a background thread's token),
[t3code#20814](https://github.com/pingdotgg/t3code/pull/20814) (the minute tick
already lives in a leaf label),
[t3code#20838](https://github.com/pingdotgg/t3code/pull/20838) (picker rows keep
their identity while searching; a new test pins it),
[t3code#20396](https://github.com/pingdotgg/t3code/pull/20396) (the sidebar is
already compiled), and
[t3code#20380](https://github.com/pingdotgg/t3code/pull/20380) (the markdown
renderer has no server config subscription and seals finished blocks).
Three are deferred.
[t3code#20842](https://github.com/pingdotgg/t3code/pull/20842)'s only f5
analogue is the add-action dialog, whose keystrokes stay inside the header
control.
[t3code#20468](https://github.com/pingdotgg/t3code/pull/20468) and
[t3code#20460](https://github.com/pingdotgg/t3code/pull/20460) prepare files
for upstream's compiler allowlist, while f5 stages compilation by `"use memo"`
annotation. Four are not applicable:
[t3code#20854](https://github.com/pingdotgg/t3code/pull/20854) (V2 lifecycle
rows), [t3code#20847](https://github.com/pingdotgg/t3code/pull/20847) (the
multi-environment atom session layer),
[t3code#20819](https://github.com/pingdotgg/t3code/pull/20819) (f5 has no
ticking "checked" labels) and
[t3code#16033](https://github.com/pingdotgg/t3code/pull/16033) (f5 loads the
whole diff patch at once).

## 15u triage log: Git, worktree and checkpoint correctness

All 39 open 15u records are classified. Eight are ported:

- [t3code#17161](https://github.com/pingdotgg/t3code/pull/17161) (15u-3):
  checkpoint diffs drop paths that a merge, pull or checkout imported after
  the capture. This follows upstream's parent-commit provenance instead of the
  plan's event and projection fields. When HEAD moves during staging, the
  capture falls back to a parentless commit rather than retrying once.
- [t3code#19411](https://github.com/pingdotgg/t3code/pull/19411): a base
  fetch that loses a ref-lock race retries once.
- [t3code#15615](https://github.com/pingdotgg/t3code/pull/15615): generated
  branch names keep their own namespace.
- [t3code#14874](https://github.com/pingdotgg/t3code/pull/14874): a
  checkpoint restore recreates the workspace directory. The Windows failure
  this targets is untested: on macOS the new test passes before the fix too.
- [t3code#17376](https://github.com/pingdotgg/t3code/pull/17376): a
  fast-forward pull whose output passes the 1 MB cap is reported as pulled.
- [t3code#17707](https://github.com/pingdotgg/t3code/pull/17707): on Windows,
  Git runs through Git for Windows' own `git.exe`, not its launcher. The tests
  simulate the Windows layout and have not run on Windows.
- [t3code#14847](https://github.com/pingdotgg/t3code/pull/14847): merge
  cleanup also removes worktrees merged by squash or rebase, when the merged
  pull request names the worktree's exact HEAD.
- [t3code#13590](https://github.com/pingdotgg/t3code/pull/13590): the toolbar
  reads "New worktree", not "Local", while a thread's worktree is being
  created.

Thirteen are equivalent, each with f5 evidence in the ledger, including
[t3code#17563](https://github.com/pingdotgg/t3code/pull/17563) (the cleanup
preview already names each skip reason; upstream's `worktreeKeepWhen` setting
has no f5 counterpart) and
[t3code#15594](https://github.com/pingdotgg/t3code/pull/15594) (every creation
path resolves the project's submodule setting).

Four stay planned. [t3code#17371](https://github.com/pingdotgg/t3code/pull/17371)
moves to 15m, which adds the `newProjectsRoot` it depends on. Three remain
open in 15u:

- [t3code#16231](https://github.com/pingdotgg/t3code/pull/16231) (15u-4, the
  worktree location setting) needs ownership records and a verified backfill
  before cleanup can act outside the managed root.
- [t3code#15625](https://github.com/pingdotgg/t3code/pull/15625) needs a
  commit-less PR action, because f5's Create PR would otherwise commit a dirty
  worktree.
- [t3code#16167](https://github.com/pingdotgg/t3code/pull/16167) affects f5
  too, but four callers reserve the temporary branch name before the worktree
  exists.

[t3code#15005](https://github.com/pingdotgg/t3code/pull/15005) (diff panel
default scope) is declined as a product choice. Six React Compiler preparation
refactors are deferred with the earlier compiler-allowlist records. Seven are
not applicable. Their subsystems are upstream-only: the thread-launch tool,
branch naming settings, orchestration v2, the worktree setup script (two
records), the previous-worktree option, and mobile.

## 15v and 15g triage log: secrets and GitHub HTTP transport

[t3code#20446](https://github.com/pingdotgg/t3code/pull/20446), the last open
15v record, is equivalent. f5 redacts secrets before settings reach a client
and masks password fields in preview snapshots. It never logs a pairing URL.

All 18 open 15g records are classified. The HTTP transport from the earlier
15g work covers six of them: the gh-for-token transport and the PR, repository
and media call sites
([t3code#16319](https://github.com/pingdotgg/t3code/pull/16319),
[t3code#16320](https://github.com/pingdotgg/t3code/pull/16320),
[t3code#16321](https://github.com/pingdotgg/t3code/pull/16321)), batched
branch lookups
([t3code#16760](https://github.com/pingdotgg/t3code/pull/16760),
[t3code#14673](https://github.com/pingdotgg/t3code/pull/14673)) and shared
routing probes ([t3code#15853](https://github.com/pingdotgg/t3code/pull/15853)).
The manual sync reset wait covers
[t3code#16203](https://github.com/pingdotgg/t3code/pull/16203). Two changes
were new in this batch:

- The plan's gh parity check found that GitHub requests no longer honored
  `HTTP(S)_PROXY`/`NO_PROXY` or the system trust store after the move off
  gh. They now use undici's fetch with an `EnvHttpProxyAgent` that trusts
  Node's roots, `NODE_EXTRA_CA_CERTS` included, plus the system store. A test
  runs a request through a local proxy to a TLS origin whose root only that
  list contains. Node 24's built-in fetch rejects an undici 8 dispatcher, so
  tests that stub the global fetch route undici's fetch through it.
- [t3code#13894](https://github.com/pingdotgg/t3code/pull/13894): a branch
  pushed to a fork without `-u` now finds its fork PR. Its remote is inferred
  from ref tips, and a tie infers nothing.

Five are equivalent:
[t3code#17063](https://github.com/pingdotgg/t3code/pull/17063) (f5's
settlement sweep is already bounded and must re-read git state),
[t3code#18289](https://github.com/pingdotgg/t3code/pull/18289),
[t3code#19375](https://github.com/pingdotgg/t3code/pull/19375),
[t3code#19162](https://github.com/pingdotgg/t3code/pull/19162) and
[t3code#11059](https://github.com/pingdotgg/t3code/pull/11059). Five are not
applicable. [t3code#19103](https://github.com/pingdotgg/t3code/pull/19103)
handles GitHub App installation tokens, which f5's `GET /user` verification
does not accept, so the plan's installation-token identity has nothing to
apply to. The other four
([t3code#19344](https://github.com/pingdotgg/t3code/pull/19344),
[t3code#19374](https://github.com/pingdotgg/t3code/pull/19374),
[t3code#16280](https://github.com/pingdotgg/t3code/pull/16280) and
[t3code#16353](https://github.com/pingdotgg/t3code/pull/16353)) change
upstream's `PullRequestService`, `client-runtime` atoms and repository
identity grouping.

The plan's one-release fallback is in place too. A `githubTransport` setting
(`http` by default) can send the same captured requests through `gh api`. It is
read per request, and Settings → Accounts → GitHub exposes it as "GitHub
requests".

## 15d triage log: HTML renders

All 11 open 15d records are classified. Three are ported:

- [t3code#16325](https://github.com/pingdotgg/t3code/pull/16325): theme
  colors passed to a page are rasterized to `#rrggbb`, so chart and canvas
  libraries that cannot parse `oklch()` or `color-mix()` get usable values.
- [t3code#19654](https://github.com/pingdotgg/t3code/pull/19654): while the
  page loads, a skeleton holds its recorded height, so the thread does not
  jump. Upstream also caches signed page URLs so a remount reuses the
  download. f5 serves pages from a stable attachment URL marked immutable, so
  the browser cache already does that.
- [t3code#18897](https://github.com/pingdotgg/t3code/pull/18897): links in a
  page go through the same handler as chat links. Pull request links open
  beside the thread, and the preview pane setting applies.

Seven are equivalent: inline pages in a sandbox
([t3code#15968](https://github.com/pingdotgg/t3code/pull/15968)), images
opening in the image viewer
([t3code#20036](https://github.com/pingdotgg/t3code/pull/20036)), full screen
with zoom ([t3code#17561](https://github.com/pingdotgg/t3code/pull/17561)),
shortcuts after a click into the page
([t3code#18898](https://github.com/pingdotgg/t3code/pull/18898)), scroll
forwarding ([t3code#16283](https://github.com/pingdotgg/t3code/pull/16283))
and mermaid diagrams
([t3code#15067](https://github.com/pingdotgg/t3code/pull/15067)). Scroll
forwarding had no test, so one was added; it fails when forwarding is removed.
[t3code#17555](https://github.com/pingdotgg/t3code/pull/17555) fixes the
Copy Image item of upstream's window context menu for images inside preview
frames. f5's menu has no such item; images in a page are copied from the image
viewer instead.

[t3code#20688](https://github.com/pingdotgg/t3code/pull/20688) is a React
Compiler memoization cleanup and is deferred with the other compiler
refactors.

## 15h triage log: PR watches

All 11 open 15h records are classified, and none needed new code. f5's
durable PR watches already cover them. Ten are equivalent:

- The 1-point GitHub fingerprint, with the full reads skipped while it is unchanged
  ([t3code#16270](https://github.com/pingdotgg/t3code/pull/16270)). Each
  skipped check logs how long the watch has been quiet
  ([t3code#16262](https://github.com/pingdotgg/t3code/pull/16262)).
- Rate limits pause a watch without counting as failures
  ([t3code#16208](https://github.com/pingdotgg/t3code/pull/16208)), and
  remark reads page through every review thread's replies
  ([t3code#15427](https://github.com/pingdotgg/t3code/pull/15427)).
- A required check that appears already passed reports passed
  ([t3code#15804](https://github.com/pingdotgg/t3code/pull/15804)), and an
  edited bot comment wakes the agent
  ([t3code#15415](https://github.com/pingdotgg/t3code/pull/15415)).
- Stop and settle end the thread's watches and cancel queued wakes
  ([t3code#16002](https://github.com/pingdotgg/t3code/pull/16002),
  [t3code#16095](https://github.com/pingdotgg/t3code/pull/16095)). The
  delegated-task half of #16002 belongs to upstream's orchestrator MCP, which
  f5 does not have.
- The thread's PR links show and stop watches
  ([t3code#16235](https://github.com/pingdotgg/t3code/pull/16235)).
- [t3code#17344](https://github.com/pingdotgg/t3code/pull/17344) fixed
  upstream's check deduper, which let a finished run hide a second run of the
  same check. f5 keeps every rollup entry, so the run still going holds back
  the passed report. A test now pins that.

[t3code#17635](https://github.com/pingdotgg/t3code/pull/17635) shortens a
client-runtime background-work title that f5 does not show, so it is not
applicable.

## 15i triage log: guided reviews

All 8 open 15i records are classified, and none needed new code. Seven are
equivalent to the guided reviews f5 already ships: the Guide tab and its
server
([t3code#18124](https://github.com/pingdotgg/t3code/pull/18124)), the guide
read and write tools
([t3code#18143](https://github.com/pingdotgg/t3code/pull/18143)), the guide
model setting ([t3code#18488](https://github.com/pingdotgg/t3code/pull/18488))
and head commits from Bitbucket, GitLab and Forgejo
([t3code#18402](https://github.com/pingdotgg/t3code/pull/18402),
[t3code#18608](https://github.com/pingdotgg/t3code/pull/18608),
[t3code#18463](https://github.com/pingdotgg/t3code/pull/18463)).
[t3code#18900](https://github.com/pingdotgg/t3code/pull/18900) fixed
upstream's checkout of a Bitbucket head given as a short hash. f5 builds
guides from the forge's diff API without a checkout, so it has no such fetch.

The plan asked for generation in an isolated checkout. f5 reads files and the
diff through the forge API instead, which needs no checkout, and its tests
cover the same run rules: coalescing, head changes, credential changes and
restarts. [t3code#18267](https://github.com/pingdotgg/t3code/pull/18267) is
the mobile guide and not applicable.

## 15e triage log: MCP apps

All 6 open 15e records are classified. One is ported:
[t3code#17962](https://github.com/pingdotgg/t3code/pull/17962) bounds long
alert dialog descriptions so the actions stay on screen. f5's MCP app approval
dialog already bounded its payload, but the shared dialog did not, and f5's
other confirmations use it.

Three are equivalent: inline MCP apps
([t3code#16236](https://github.com/pingdotgg/t3code/pull/16236)), the
blocked-cookie bootstrap
([t3code#17027](https://github.com/pingdotgg/t3code/pull/17027)) and the host
color scheme for saved apps
([t3code#17026](https://github.com/pingdotgg/t3code/pull/17026)). f5 injects
both bootstraps when it saves the snapshot, not when it serves it. Two React
Compiler cleanups
([t3code#20759](https://github.com/pingdotgg/t3code/pull/20759),
[t3code#20691](https://github.com/pingdotgg/t3code/pull/20691)) are deferred.

Two items the plan added beyond upstream are not built: single-use approval
tokens valid for 60 seconds, and durable receipts for MCP app tool calls. f5
checks approval against the session identity the user reviewed and sends each
mutation once, never replaying it after a timeout. The server still accepts
the client's `approved` flag, though, and there is no idempotent operation id
to dedupe a retried call. These remain open plan work.

## 15c triage log: thread settlement

All 21 open 15c records are classified. Two are ported:

- [t3code#17258](https://github.com/pingdotgg/t3code/pull/17258): a refused
  settle now names its blocker and what to do first. Before, every blocker gave
  one generic message, and the row and header menus showed nothing at all.
- [t3code#17148](https://github.com/pingdotgg/t3code/pull/17148): a merge
  seen by the thread's Git status now starts a settlement sweep at once.
  Before, it waited for the PR hub or the five-minute schedule.

Seventeen are equivalent to the settlement f5 already ships: the settings
and per-thread switch, agent-requested settles, PR and inactivity rules,
settle scripts, worktree cleanup, idle shells, sweep triggers and the sidebar
bucket. [t3code#15604](https://github.com/pingdotgg/t3code/pull/15604) (keep
settled threads asleep after restarts) holds by construction. f5 records a
restart continuation only for an active turn or live background work, and
both refuse settlement.
[t3code#19328](https://github.com/pingdotgg/t3code/pull/19328) aligned
upstream's settle shortcut with its sidebar button. In f5 they already run
the same action.

Two are not applicable:
[t3code#19355](https://github.com/pingdotgg/t3code/pull/19355) and
[t3code#15546](https://github.com/pingdotgg/t3code/pull/15546) handle
upstream releasing or unloading provider sessions when a thread settles. f5
settling leaves the session alone.

## 15t triage log: provider adapters and queue correctness

All 158 open 15t records are classified: 28 ported, 34 equivalent, 64 not
applicable, 31 deferred and 1 declined. Each port has a regression test.

Claude:

- [t3code#13999](https://github.com/pingdotgg/t3code/pull/13999): Stop lets
  Claude abort the turn, waiting up to 3 seconds, before closing the session.
- [t3code#19322](https://github.com/pingdotgg/t3code/pull/19322): the CLI runs
  in its own process group, and the group is killed on exit, so plugin MCP
  servers no longer outlive the session. This does not apply on Windows.
- [t3code#15872](https://github.com/pingdotgg/t3code/pull/15872): a 403 shows
  the CLI's own text instead of asking to log in again.
- [t3code#18706](https://github.com/pingdotgg/t3code/pull/18706): probes and
  text generation drop `--strict-mcp-config` when an enterprise
  `managed-mcp.json` exists.
- [t3code#19394](https://github.com/pingdotgg/t3code/pull/19394): failed text
  generation shows the CLI's error result.
- [t3code#19320](https://github.com/pingdotgg/t3code/pull/19320): instance
  probes run in the state directory instead of `$HOME`.
- [t3code#16358](https://github.com/pingdotgg/t3code/pull/16358): the limits
  read skips the transcript scan.
- [t3code#17778](https://github.com/pingdotgg/t3code/pull/17778): a gateway's
  wrapped 429 cooldown becomes the usage limit's reset, so the queue resumes
  the turn.

Codex:

- [t3code#19635](https://github.com/pingdotgg/t3code/pull/19635): "Always
  allow this session" covers later commands.
- [t3code#19368](https://github.com/pingdotgg/t3code/pull/19368): new threads
  give optional MCP servers a 10 second startup grace.
- [t3code#17058](https://github.com/pingdotgg/t3code/pull/17058): text
  generation turns the user's MCP servers off.
- [t3code#17663](https://github.com/pingdotgg/t3code/pull/17663): shadow homes
  replace Codex-created runtime locks with the shared ones.
- [t3code#15389](https://github.com/pingdotgg/t3code/pull/15389): an archived
  session is unarchived and resumed instead of failing the start.

ACP, Grok, Muse and OpenCode:

- [t3code#20015](https://github.com/pingdotgg/t3code/pull/20015): one
  undecodable session update is dropped instead of ending the session.
- [t3code#19313](https://github.com/pingdotgg/t3code/pull/19313): a custom ACP
  instance's configured models reach the agent.
- [t3code#13386](https://github.com/pingdotgg/t3code/pull/13386): progress from
  a tool that is already shown no longer splits the answer.
- [t3code#18075](https://github.com/pingdotgg/t3code/pull/18075): Grok health
  checks keep its updater off.
- [t3code#14486](https://github.com/pingdotgg/t3code/pull/14486): Grok CLIs
  older than 1.0.13 report as too old.
- [t3code#19558](https://github.com/pingdotgg/t3code/pull/19558): Muse gets
  its permission profile on start and resume, on durable hosts only, since
  the ephemeral host refuses one.
- [t3code#12469](https://github.com/pingdotgg/t3code/pull/12469): the OpenCode
  error formatter survives a message-less error.
- [t3code#14198](https://github.com/pingdotgg/t3code/pull/14198): OpenCode 2.x
  reports as unsupported, since f5 only speaks the 1.x protocol.
- [t3code#13368](https://github.com/pingdotgg/t3code/pull/13368): f5 stops
  naming OpenCode sessions `T3 Code <thread id>`, so OpenCode titles them.
- [t3code#17424](https://github.com/pingdotgg/t3code/pull/17424), web half:
  OpenCode Zen and Go rows show the sub-provider on its own.

Elsewhere:

- [t3code#13295](https://github.com/pingdotgg/t3code/pull/13295): after a
  failed dispatch, the engine republishes only the events that dispatch
  appended. Events another server wrote to a shared state directory no longer
  start a second turn.
- [t3code#19364](https://github.com/pingdotgg/t3code/pull/19364): pasted images
  are scaled to a 2000px long edge.
- [t3code#19340](https://github.com/pingdotgg/t3code/pull/19340): mise's
  `__MISE_DIFF` travels with `PATH` from the login shell.
- [t3code#7079](https://github.com/pingdotgg/t3code/pull/7079): the
  Antigravity editor opens the IDE (`antigravity-ide`), not the `agy` CLI.
- [t3code#13373](https://github.com/pingdotgg/t3code/pull/13373), web half: the
  Antigravity icon drops its baked-in tile.

Most of the not-applicable records belong to upstream's orchestration-v2,
OpenCode 2 adapter, delegated tasks, model manifest, Cursor SDK, relay or
mobile app, none of which f5 has. Equivalents include f5's per-turn
permission mode reset, its fresh random prompt uuids, its live-session
command lists, its crashed-agent handling for Grok and its server-side
queue for messages sent while a thread is closed.

Deferred, in order of risk:

- [t3code#13547](https://github.com/pingdotgg/t3code/pull/13547) is the most
  important open item. When a newer Codex model's catalog ships its own
  collaboration-mode text, Codex drops the client's `developer_instructions`.
  f5 sends all of its instructions there: the mode prompt, runtime info,
  project memories and resumed context. The fix moves them to `turn/start`
  `additionalContext`. That needs a Codex version gate, entries kept under
  Codex's per-entry token cap and a restore after compaction, and each of
  these has to be checked against a live Codex.
- [t3code#16908](https://github.com/pingdotgg/t3code/pull/16908) drops the
  200k/1M choice from Claude 5-series models. f5 still offers it on Fable 5
  and Sonnet 5, and routes 1M through the `[1m]` suffix and a Fable 5.1
  switch, so the change waits on confirming what the CLI does without the
  suffix.
- [t3code#14896](https://github.com/pingdotgg/t3code/pull/14896) needs an
  `interrupted` tool status in the runtime contract.
- [t3code#16958](https://github.com/pingdotgg/t3code/pull/16958) and
  [t3code#15416](https://github.com/pingdotgg/t3code/pull/15416) change how
  provider updates run: a live progress channel, and self-updaters for
  unproven installs.
- The live command output hub
  ([t3code#15094](https://github.com/pingdotgg/t3code/pull/15094)), Claude 5
  task lists ([t3code#14964](https://github.com/pingdotgg/t3code/pull/14964)),
  Claude 5.1 progress text
  ([t3code#18923](https://github.com/pingdotgg/t3code/pull/18923)), Codex
  follow-up directives
  ([t3code#19401](https://github.com/pingdotgg/t3code/pull/19401)), Muse 1.4.6
  presentation ([t3code#18409](https://github.com/pingdotgg/t3code/pull/18409)),
  Muse on Windows ([t3code#17163](https://github.com/pingdotgg/t3code/pull/17163)),
  the Sol Ultrafast originator
  ([t3code#18200](https://github.com/pingdotgg/t3code/pull/18200)) and the Muse
  logo ([t3code#19562](https://github.com/pingdotgg/t3code/pull/19562)) are
  features rather than fixes.
- Eighteen React Compiler cleanups are deferred together.

[t3code#18364](https://github.com/pingdotgg/t3code/pull/18364) is declined
because upstream reverted it.

Two ledger corrections came out of this batch. First, the
[t3code#17414](https://github.com/pingdotgg/t3code/pull/17414) reason cited
the fixed OpenCode title that the
[t3code#13368](https://github.com/pingdotgg/t3code/pull/13368) port then
removed, so it now cites
the untitled session create. Second, later edits in this batch had shifted
the line numbers of 103 earlier evidence citations. Those were remapped
through the git diff, and none of the cited lines had itself changed. A few
citations from earlier workstreams already pointed at closing braces before
this batch; they are unchanged.

## 15r triage log: subagents and the Agents panel

All 29 open 15r records are classified: 14 ported, 7 equivalent, 7 not
applicable and 1 deferred.

Twelve records already had implementations and failing-before reproductions
from the Agents verify-first work above. Their cited tests pass again today,
and they are now recorded as ported. Their evidence citations were also
rewritten. Several pointed into the middle of a test, or at a blank line,
because the files had shifted since the citations were first recorded. The
15t remap only carried those stale lines forward. Each now names the test
itself.

Two fixes are new in this batch:

- [t3code#16752](https://github.com/pingdotgg/t3code/pull/16752): F5 has no
  agent-facing HTML layout guide, so the `html_render` tool description now
  says to leave html, body and the outermost element without a background,
  and to pad and round any box that needs its own.
- [t3code#16878](https://github.com/pingdotgg/t3code/pull/16878): F5 folds
  only the work groups above the newest user message, so a settled turn's
  cards already stay visible. A steer adds such a message while a foreground
  subagent keeps working. A group with an in-progress subagent now stays open
  until the subagent ends. The fixture fails before the change.

Equivalent:

- [t3code#20785](https://github.com/pingdotgg/t3code/pull/20785): the Agents
  panel counts live durable work from every turn. Unlike upstream, it keeps
  listing live work from a reverted turn, because that work is still running
  and can be stopped from the panel.
- [t3code#14540](https://github.com/pingdotgg/t3code/pull/14540) and
  [t3code#14994](https://github.com/pingdotgg/t3code/pull/14994): a
  subagent's model comes from its own first snapshot, which includes
  agent-file overrides, and the correction is pushed at once. Nested Agent
  calls inherit the model of the subagent that launched them.
- [t3code#13056](https://github.com/pingdotgg/t3code/pull/13056): agent cards
  show the native effort. Upstream's speed value comes from an app-owned
  child thread, which F5 does not have.
- [t3code#16486](https://github.com/pingdotgg/t3code/pull/16486),
  [t3code#18778](https://github.com/pingdotgg/t3code/pull/18778) and
  [t3code#18375](https://github.com/pingdotgg/t3code/pull/18375): a background
  task's progress and outcome are recorded against its own turn while the
  parent is idle, a stop waits for the confirmed outcome, and progress rows
  never repeat the prompt.

Not applicable: upstream's changes for renamed worktree branches, shared
worktree cleanup, pending approvals and questions, and resumed follow-ups
([t3code#20079](https://github.com/pingdotgg/t3code/pull/20079),
[t3code#19748](https://github.com/pingdotgg/t3code/pull/19748),
[t3code#19630](https://github.com/pingdotgg/t3code/pull/19630),
[t3code#16634](https://github.com/pingdotgg/t3code/pull/16634),
[t3code#17696](https://github.com/pingdotgg/t3code/pull/17696)) all concern
delegated child threads. F5 subagents run inside the parent's session, and
their approvals and questions are already pending requests on the parent.
[t3code#14108](https://github.com/pingdotgg/t3code/pull/14108) changes
orchestration-v2 adapters only, and
[t3code#15189](https://github.com/pingdotgg/t3code/pull/15189) is mobile.

Deferred: [t3code#19291](https://github.com/pingdotgg/t3code/pull/19291) is
mostly upstream's update-all flow. The part that applies is the desktop
backend's kill grace. F5 kills the backend 2 seconds after asking it to
stop, while its service launcher waits 5. Raising the grace also means
retuning the stop timeouts and the 6-second quit cap. None of that can be
exercised here without a runnable Electron build.

## 15b triage log: observability

All 15 open 15b records are classified: 10 ported, 3 equivalent, 1 not
applicable and 1 deferred.

Most of 15b was already implemented in the work-in-progress commit
`f46c26cd2c` and the trace-writer change in `aaff303849`. That covers OTLP
export of traces and metrics over both protocols, the standard endpoint,
header and protocol variables, the SDK and per-signal kill switches, lenient
resource attributes, the SIGUSR2 heap snapshot, the trace summary command,
event-loop stall spans and the Diagnostics OTLP card with secret-backed
headers. Their tests pass, and the records now cite them.

Two gaps were fixed in this batch:

- [t3code#19370](https://github.com/pingdotgg/t3code/pull/19370): the OTLP
  resource took its version from `npm_package_version` and reported 0.1.0
  for any server not started by a package script. It also overrode a
  `host.name` set in `OTEL_RESOURCE_ATTRIBUTES`. It now uses the server's
  package version, and an explicit host name wins.
- [t3code#19430](https://github.com/pingdotgg/t3code/pull/19430): trace
  writes already ran in a separate process, but provider event logs, which
  are always on, still appended synchronously on the event loop. They now
  use an asynchronous rotating sink with the same per-chunk rotation. It
  makes one write at a time and bounds the chunks waiting behind a slow
  write. Drops and failures are counted, and closing drains for at most 2
  seconds.

Equivalent: F5's only subprocess spans are Git's, which name the operation
([t3code#13701](https://github.com/pingdotgg/t3code/pull/13701)). The empty
spans upstream removes have no F5 counterpart
([t3code#13756](https://github.com/pingdotgg/t3code/pull/13756)). The
desktop backend inherits the OTLP variables
([t3code#13641](https://github.com/pingdotgg/t3code/pull/13641)). Not
applicable: F5's Diagnostics has no trace view
([t3code#13763](https://github.com/pingdotgg/t3code/pull/13763)).

Deferred: [t3code#19425](https://github.com/pingdotgg/t3code/pull/19425).
Stalls already keep their own history. The SQL half relies on
`Statement.SpanPropagationEnabled`, which F5's pinned effect-smol does not
have. A probe showed that F5's existing `db.connection.wait_ms` annotation
lands on the caller's span, not on the `sql.execute` or `sql.transaction` span,
because those spans are not current while the connection is acquired. The
wait-time metric itself is correct.

## 15c overlay: the 26 September settlement records

The 26 September records that a user decision moved into 15c are now
reconciled against F5's settlement implementation: 3 ported, 19 equivalent
and 4 still deferred. The plan keeps them as `planned:15c` overrides, so the
outcome lives only in the ledger. The plan test now accepts `equivalent` as
well as `ported` when a reapplied override keeps its proof, which matches what
`applyPortPlan` already does.

Ported, with the proof recorded on 2026-10-19:
[t3code#9934](https://github.com/pingdotgg/t3code/pull/9934) (actual merge
and close times, never updated times),
[t3code#10424](https://github.com/pingdotgg/t3code/pull/10424) (no reads
while both automatic policies are off) and
[t3code#8600](https://github.com/pingdotgg/t3code/pull/8600) (server-side
settlement with a saved-branch lookup that needs no status scan).

Equivalent: the server behaviors map to existing settlement tests. These are
settling as soon as branch status sees a merge
([t3code#9528](https://github.com/pingdotgg/t3code/pull/9528),
[t3code#12161](https://github.com/pingdotgg/t3code/pull/12161)), using the
last activity as the settled time
([t3code#9254](https://github.com/pingdotgg/t3code/pull/9254)), sharing
branch reads ([t3code#9459](https://github.com/pingdotgg/t3code/pull/9459)),
settling inactivity before any host contact
([t3code#10103](https://github.com/pingdotgg/t3code/pull/10103)), keeping
threads with PRs unless the user opts out
([t3code#9610](https://github.com/pingdotgg/t3code/pull/9610)) and using a
merge only once ([t3code#7454](https://github.com/pingdotgg/t3code/pull/7454)).
Automatic settlement is opt-in, with server settings that default off
([t3code#8321](https://github.com/pingdotgg/t3code/pull/8321),
[t3code#8596](https://github.com/pingdotgg/t3code/pull/8596),
[t3code#9147](https://github.com/pingdotgg/t3code/pull/9147)). Un-settling
moves a thread back to the top
([t3code#8231](https://github.com/pingdotgg/t3code/pull/8231)). In the
client, settled rows are muted until hover or focus
([t3code#11101](https://github.com/pingdotgg/t3code/pull/11101),
[t3code#10023](https://github.com/pingdotgg/t3code/pull/10023)), show the
project icon ([t3code#9366](https://github.com/pingdotgg/t3code/pull/9366))
and label the Unsettle action
([t3code#7796](https://github.com/pingdotgg/t3code/pull/7796)). The settled
shelf starts collapsed
([t3code#9314](https://github.com/pingdotgg/t3code/pull/9314)), opening a
project never picks a settled thread
([t3code#11804](https://github.com/pingdotgg/t3code/pull/11804)), and
assistant messages are never folded
([t3code#7723](https://github.com/pingdotgg/t3code/pull/7723)). The
`thread.toggleSettled` command exists without a default binding
([t3code#8089](https://github.com/pingdotgg/t3code/pull/8089)), as pinning
does.

Still deferred, because F5 chose differently:

- [t3code#5379](https://github.com/pingdotgg/t3code/pull/5379) and
  [t3code#7969](https://github.com/pingdotgg/t3code/pull/7969): settling a
  snoozed or pinned thread clears that state upstream. F5 refuses and says
  which state to clear first.
- [t3code#10400](https://github.com/pingdotgg/t3code/pull/10400): upstream
  allows settling with an unanswered question. F5 refuses until it is
  answered.
- [t3code#9033](https://github.com/pingdotgg/t3code/pull/9033) aligns a
  composer un-settle banner that F5 does not have; un-settling is in the
  thread header.

## 15j triage log: PR hub UX

All 12 open 15j records were already implemented with focused tests. They are
now recorded as ported, and each cites its specific tests instead of a whole
file. The records cover:

- middle-click and modified clicks opening PR links in the browser
  ([t3code#19854](https://github.com/pingdotgg/t3code/pull/19854))
- the setting to open PR links on the forge
  ([t3code#19719](https://github.com/pingdotgg/t3code/pull/19719))
- confirming PR panel actions in place
  ([t3code#17710](https://github.com/pingdotgg/t3code/pull/17710))
- the opt-in removal of agent credits from merge messages
  ([t3code#16192](https://github.com/pingdotgg/t3code/pull/16192))
- head-fenced branch deletion after merge or close
  ([t3code#19257](https://github.com/pingdotgg/t3code/pull/19257))
- Shift-held, fast and right-click PR actions
  ([t3code#15549](https://github.com/pingdotgg/t3code/pull/15549),
  [t3code#16627](https://github.com/pingdotgg/t3code/pull/16627),
  [t3code#16612](https://github.com/pingdotgg/t3code/pull/16612))
- per-forge and per-item capabilities
  ([t3code#17774](https://github.com/pingdotgg/t3code/pull/17774),
  [t3code#17667](https://github.com/pingdotgg/t3code/pull/17667))
- bot and resolved filters for review threads
  ([t3code#17645](https://github.com/pingdotgg/t3code/pull/17645))
- dragging a linked PR into the composer
  ([t3code#20102](https://github.com/pingdotgg/t3code/pull/20102))

The cited server, contracts and web unit suites pass 107, 15 and 35 cases, and
the linked-PR drop case in `ChatView.browser.tsx` passes. The combined browser
run passed 37 of 38 cases. The one failure was an uncited case, "returns focus
from a composer option menu on Escape", which timed out; its file passes all 10
cases when run alone.

## 15k triage log: per-project providers and custom ACP agents

All 9 open 15k records are classified: 2 ported, 5 not applicable, 1 declined
and 1 deferred.

Ported, with existing implementations whose cited tests pass:
[t3code#17879](https://github.com/pingdotgg/t3code/pull/17879) turns
providers on or off per project, and
[t3code#16021](https://github.com/pingdotgg/t3code/pull/16021) adds custom
local ACP agents.

Not applicable: five records change upstream's ACP Registry provider, which
F5 lists as coming soon and does not implement. They cover its test fixtures,
search list, package move and service-convention refactor.

Declined: [t3code#14915](https://github.com/pingdotgg/t3code/pull/14915)
drops Pi's Early Access badge. F5's Pi driver is new in this catch-up, so it
keeps the badge with Cursor, Grok and Muse Code.

Deferred: [t3code#16816](https://github.com/pingdotgg/t3code/pull/16816)
shares model favorites, hidden models and order across clients. F5 keeps them
in each client's local settings, so this means moving them into server settings
and migrating existing values. Upstream's change is about a thousand lines, so
it is feature work for its own block.

## 15l triage log: Pi

All 21 open 15l records are classified: 17 ported, 1 equivalent and 3 not
applicable. The Pi driver from the earlier 15l checkpoints already covered 16
of the ported records. Each record now cites the specific tests for its
behavior instead of whole files, and those tests pass.

New port: [t3code#18639](https://github.com/pingdotgg/t3code/pull/18639).
Pi can start native extension work before its wake reaches F5. A prompt sent
in that window had no `streamingBehavior`, so Pi rejected it and the user's
turn failed. Prompts now ask Pi to steer, so Pi queues the prompt into the
running work or starts an idle run as before. The fake Pi process gains a
`streaming` case that rejects a prompt without `streamingBehavior`, as real
Pi does. That case fails before the fix (the turn ends `failed`) and passes
after it. A wake that F5 has already seen still waits for queue admission.

Equivalent: [t3code#17407](https://github.com/pingdotgg/t3code/pull/17407)
adds driver tests for continuation offers. F5 covers the offer, admission and
adoption in the adapter and continuation-worker tests.

Not applicable: three upstream refactors. They switch to namespace imports
([t3code#17375](https://github.com/pingdotgg/t3code/pull/17375)), apply
upstream's Effect service conventions
([t3code#17542](https://github.com/pingdotgg/t3code/pull/17542)), and move Pi
into its own package
([t3code#17302](https://github.com/pingdotgg/t3code/pull/17302)). F5 keeps
the Pi driver in the server app with the other providers.

All of this is tested against a scripted Pi RPC process. No installed Pi or
real Pi account was used, because Pi is not installed on this machine. Pi
stays in early access, and `docs/providers/pi.md` now says so instead of
calling the Pi phase undelivered.

Validation: 339 server tests in 23 files, including every Pi test file, pass,
as do the 2 shared native-history reconciliation tests, the 18 browser cases
for the model picker and question panel, and the 2 ChatView prefill cases.
The server typecheck passes.

## 15o triage log: chat UX

All 21 open 15o records are classified: 8 ported, 5 equivalent, 6 not
applicable and 2 deferred.

New ports, each with a test that fails before the change:

- [t3code#17954](https://github.com/pingdotgg/t3code/pull/17954): opening a
  command, work group, file diff or directory tree at the end of a thread left
  its new content below the viewport (a 365px gap in the test). A toggle made
  at the end now keeps the list at the end while rows re-measure. Scrolled up,
  the toggled row still holds its place.
- [t3code#16311](https://github.com/pingdotgg/t3code/pull/16311): F5's editor
  draft store, its only IndexedDB use, kept a connection the browser had
  closed, so every later draft save failed until a reload. It now reopens
  the connection, with concurrent callers sharing the new one.
- [t3code#19197](https://github.com/pingdotgg/t3code/pull/19197): agent
  questions render as chat Markdown, so URLs and file links are clickable.
- [t3code#16284](https://github.com/pingdotgg/t3code/pull/16284): while a
  tool runs, the working row keeps the turn's latest thought above it.
- [t3code#13572](https://github.com/pingdotgg/t3code/pull/13572): the
  background-task tray, F5's counterpart to upstream's agents-working banner,
  links to the Agents panel.
- [t3code#15824](https://github.com/pingdotgg/t3code/pull/15824): upstream
  reverted its automatic repair of unclosed file links, so F5's port of that
  repair is removed too. The record for the original
  ([t3code#15520](https://github.com/pingdotgg/t3code/pull/15520)) now cites
  both commits and the test that pins the reverted behavior.

Ported earlier and now verified:
[t3code#10439](https://github.com/pingdotgg/t3code/pull/10439), find in
thread. Its server, shared and browser tests pass, so the record is
promoted with specific test citations.

Equivalent: F5 already has a chat width setting
([t3code#11594](https://github.com/pingdotgg/t3code/pull/11594)) and Run in
terminal on shell code blocks
([t3code#13060](https://github.com/pingdotgg/t3code/pull/13060)). It sends a
quote as a blockquote plus comment, so the sent message shows both
([t3code#15703](https://github.com/pingdotgg/t3code/pull/15703)). It never
took the trailing toast icons that
[t3code#18356](https://github.com/pingdotgg/t3code/pull/18356) reverts. Its
reasoning panel has no capped scroller to pin
([t3code#19334](https://github.com/pingdotgg/t3code/pull/19334)).

Not applicable: two type-to-focus fixes
([t3code#13553](https://github.com/pingdotgg/t3code/pull/13553),
[t3code#14595](https://github.com/pingdotgg/t3code/pull/14595)), since F5 has
no type-to-focus. Two orchestration-v2 fixes
([t3code#15505](https://github.com/pingdotgg/t3code/pull/15505),
[t3code#15059](https://github.com/pingdotgg/t3code/pull/15059)). The Tiptap
bold shortcut ([t3code#13409](https://github.com/pingdotgg/t3code/pull/13409)).
The relay and Android alert stacking
([t3code#12048](https://github.com/pingdotgg/t3code/pull/12048)). The Waiting
status icon ([t3code#19617](https://github.com/pingdotgg/t3code/pull/19617)),
since F5 has no Waiting status.

Deferred as feature work for their own blocks: block-level Markdown in the
rich text composer
([t3code#14677](https://github.com/pingdotgg/t3code/pull/14677), about 3,800
lines of Tiptap work, while F5's composer is Lexical), and shell command
syntax highlighting
([t3code#15037](https://github.com/pingdotgg/t3code/pull/15037), which adds
the `unbash` dependency and builds on upstream's V2 item inspector).

A pre-existing failure turned up along the way: the file view panel's browser
suite had not loaded since `useOpenLink` started calling `useRouter` in
`144d0a2460`, because its router mock lacked `useRouter`. The mock is fixed
and its 4 cases pass.

Validation: the timeline and ChatView browser suites pass (205 cases), as
do the question panel (15), tray (8), editor draft (4), file view (4) and
ChatMarkdown (8) suites, 187 web unit tests across the session-logic and
timeline files, and the find-in-thread suites. The web typecheck passes.

## 15p triage log: keyboard, tabs and workspace UX

All 13 open 15p records are classified: 11 ported, 1 equivalent and 1
deferred.

New ports:

- [t3code#14542](https://github.com/pingdotgg/t3code/pull/14542): the command
  palette offers Restart agent session while the provider process is idle. It
  stops the process but keeps the conversation, then rescans that provider
  instance, so new skills, plugins and MCP servers load on the next message.
  The first version of the test caught a real bug: the palette's thread
  summary has no session, so the action never appeared. It now reads the
  session from the store.
- [t3code#17091](https://github.com/pingdotgg/t3code/pull/17091), keyboard
  part only: in F5's xterm terminal, Cmd+A on macOS or Ctrl+Shift+A elsewhere
  selects all retained output, and mod+Shift+Home/End jump to the start and
  the latest output outside full-screen programs. Upstream's snapshot and
  selection work is in its Ghostty surface, which F5 lacks. F5's right-click
  menu appears only for a selection, so it has no Select all or Jump to latest
  entries.
- [t3code#17149](https://github.com/pingdotgg/t3code/pull/17149): projects
  can use a macOS `.icns` app icon, either discovered at
  `Resources/AppIcon.icns` or `AppIcon.icns` or named in `f5.json`. The asset
  reader serves the smallest embedded PNG at least 96px wide, and reads
  `.icns` files under an 8 MB cap instead of 1 MB.
- [t3code#12822](https://github.com/pingdotgg/t3code/pull/12822): keybinding
  settings are grouped by area, and search hides groups it empties. F5's
  editor already had the toolbar.
- [t3code#15207](https://github.com/pingdotgg/t3code/pull/15207),
  [t3code#17664](https://github.com/pingdotgg/t3code/pull/17664) and
  [t3code#18740](https://github.com/pingdotgg/t3code/pull/18740), ported
  earlier in this batch: reopening a closed tab works from anywhere and returns
  to its thread, the Home project picker is searchable, and the sidebar's
  running-terminal indicator opens that terminal. The `vp i --yes` half of
  t3code#18740 does not apply, because F5's setup does not run vp.

Already in F5 and now cited with tests:
[t3code#15686](https://github.com/pingdotgg/t3code/pull/15686) (Mod+T tab
menu), [t3code#17730](https://github.com/pingdotgg/t3code/pull/17730) (drag to
reorder tabs), [t3code#19928](https://github.com/pingdotgg/t3code/pull/19928)
(step reasoning effort) and
[t3code#15050](https://github.com/pingdotgg/t3code/pull/15050) (send and open
a new thread).

Equivalent: [t3code#15326](https://github.com/pingdotgg/t3code/pull/15326)
retries a failed orchestration-v2 workspace preparation. F5's worktree setup
card already retries a failed or cancelled setup on the same worktree and
then starts the queued first turn.

Deferred: [t3code#14623](https://github.com/pingdotgg/t3code/pull/14623), find
in diffs. It depends on an 869-line vendor patch to `@pierre/diffs` 1.5.2,
while F5 is on 1.1.0-beta.19 and has no patched-dependency setup.

Validation: the ChatView browser suite passes (133 cases), as do the
navigation controller, Home, sidebar row, right panel host and tab menu,
keybinding editor and terminal drawer browser suites (23 cases), 83 web unit
tests across the right panel store, keybindings, effort levels and keybinding
grouping, and 10 server tests for `.icns` decoding and the favicon route. The
web and server typechecks pass.

## 15q triage log: Usage

All 10 open October 15q records are classified: 5 ported and 5 deferred. The
September 11a carrier records for this workstream are triaged separately.

New ports:

- [t3code#9434](https://github.com/pingdotgg/t3code/pull/9434): `mod+U`
  (`usage.open`) opens Usage from anywhere outside the terminal.
- [t3code#11391](https://github.com/pingdotgg/t3code/pull/11391): F5's
  Projects and threads card ranked rows by the chart metric but always showed
  a token share. Share now follows tokens, cost or recorded turns, a row with
  an unknown cost has no cost share, and the Providers and models table ranks
  by the same metric. The new test fails before the change.
- [t3code#16970](https://github.com/pingdotgg/t3code/pull/16970): a saved
  provider menu replaces the single History provider select and applies to
  both tabs. The server leaves hidden providers out of fact and legacy cost
  totals, and their account cards are hidden.
- [t3code#10158](https://github.com/pingdotgg/t3code/pull/10158): on Usage,
  T, C, R and L switch views, 1 to 4 pick the range and Escape goes back.
  Upstream uses mod+Shift+1..4 for ranges. F5 uses bare digits because
  Cmd+Shift+3 and Cmd+Shift+4 are macOS screenshot keys and never reach the
  app.
- [t3code#15333](https://github.com/pingdotgg/t3code/pull/15333): model
  mappings count one model as another, so a preview model can report and
  price as its released name.

Deferred:

- [t3code#15108](https://github.com/pingdotgg/t3code/pull/15108) splits cost
  by token type and speed. It depends on upstream's built-in price table and
  a per-record service tier, and F5 has neither.
- [t3code#13118](https://github.com/pingdotgg/t3code/pull/13118) (Claude
  banked resets) and
  [t3code#17530](https://github.com/pingdotgg/t3code/pull/17530)
  (Antigravity quota) need a security review first. Both read a CLI's stored
  OAuth credentials and call undocumented endpoints. F5 reads limits today
  without touching provider credential files. Upstream also does not offer
  the Claude feature on macOS.
- [t3code#10409](https://github.com/pingdotgg/t3code/pull/10409) (Cursor,
  OpenCode and Antigravity history) and
  [t3code#17848](https://github.com/pingdotgg/t3code/pull/17848) (Pi native
  sessions) are about 3,600 lines of native-store scanners. They also need
  the plan's `usage_native_records` design, so they get their own block.

Validation: the Usage dashboard and price editor browser suites pass (42
cases), as do 14 usage service tests, the usage facts repository tests
including the new hidden-provider assertions, and the keybinding, shortcut
reference, conflict-label, editor-grouping and Usage search unit suites. The
server and web typechecks pass.

## 15s triage log: desktop

All 10 open October 15s records are classified: 7 ported, 2 not applicable
and 1 deferred. The September 13a, 13b and 14 carriers are triaged separately.

New ports:

- [t3code#17726](https://github.com/pingdotgg/t3code/pull/17726): in the
  macOS app, tooltips treat the 52px header with the traffic lights as
  off-screen and flip instead of opening under them.
- [t3code#18238](https://github.com/pingdotgg/t3code/pull/18238): an
  Option/Alt-clicked chat link opens the system browser, like the other
  modifier clicks, instead of F5's in-app preview.
- [t3code#14601](https://github.com/pingdotgg/t3code/pull/14601): preview
  tabs get an opaque white base, so dark-scheme Markdown and plain-text pages
  are no longer white on white.

Already in F5 and now cited with tests: the compile cache for the packaged
app and backend
([t3code#13501](https://github.com/pingdotgg/t3code/pull/13501)), CA trust
variables from the login shell
([t3code#19604](https://github.com/pingdotgg/t3code/pull/19604)), and
installing the CLI commands from Settings, including the refusal to install
behind another `t3`
([t3code#16683](https://github.com/pingdotgg/t3code/pull/16683),
[t3code#17351](https://github.com/pingdotgg/t3code/pull/17351)). As the plan
asked, the Agent Bridge docs now show `f5` instead of `t3`.

Not applicable: [t3code#12006](https://github.com/pingdotgg/t3code/pull/12006)
keeps upstream's managed cloud tunnel across update restarts, and
[t3code#16939](https://github.com/pingdotgg/t3code/pull/16939) fixes its
Playwright CDP relay. F5 has neither.

Deferred, as the plan requires:
[t3code#16952](https://github.com/pingdotgg/t3code/pull/16952), preview
passkeys. They need the native `electron-webauthn` module, Apple's
web-browser passkey entitlement and a signed-build test on a real relying
party.

Validation: 22 desktop tests across the preview runtime, shell environment
and compile cache pass, as do the tooltip unit test, the new chat link browser
test and the ChatMarkdown unit suite. The desktop and web typechecks pass.
Electron cannot launch in this environment, so the tooltip and preview
changes were not checked in a running desktop window.

## September set 10 triage log: chat and composer follow-ups

All 49 "verify this follow-up" records carried by set 10 (the 15o carrier) are
classified: 8 ported, 6 equivalent, 34 not applicable and 1 moved to Phase 2.
The "Phase 10 implementation" records stay as they are, held by the open
performance release gates.

New ports:

- [t3code#10154](https://github.com/pingdotgg/t3code/pull/10154): composer
  suggestions work with screen readers. The editor is labelled, announces a
  listbox and points `aria-activedescendant` at the highlighted option, and an
  empty or loading list is announced.
- [t3code#15509](https://github.com/pingdotgg/t3code/pull/15509): a file link
  whose text is prose keeps that text in front of the file chip.
- [t3code#12615](https://github.com/pingdotgg/t3code/pull/12615): Windows path
  link destinations keep their backslashes. F5 also lacked upstream's local-path
  URL transform ([t3code#1867](https://github.com/pingdotgg/t3code/pull/1867)),
  so `C:\`, UNC and `file://` links rendered with an empty href and never became
  chips; local file destinations are now kept and other schemes are sanitized as
  before.
- [t3code#17728](https://github.com/pingdotgg/t3code/pull/17728): image-only
  links lose the link underline.
- [t3code#15455](https://github.com/pingdotgg/t3code/pull/15455): a hovered
  timeline tooltip closes when the timeline scrolls, unless its trigger has
  focus.
- [t3code#12900](https://github.com/pingdotgg/t3code/pull/12900): an answered
  user-input row leads with the agent's question and shows the answers.
- [t3code#19107](https://github.com/pingdotgg/t3code/pull/19107): a slash after
  other text searches skills. Unlike upstream, the menu opens there only when a
  skill matches and offers no mode or model commands, so typing a path such as
  `/Users/me` mid-message shows no menu.
- [t3code#19319](https://github.com/pingdotgg/t3code/pull/19319): OpenCode gets
  only plain text, PDF and image attachments as native file parts, so HTML and
  Markdown attachments no longer fail the turn.

Equivalent: chat markdown renders HTML as text, so a bare `<A>` placeholder
cannot open a link
([t3code#16637](https://github.com/pingdotgg/t3code/pull/16637), now pinned by a
test). The timeline saves its position from live geometry and stays at the end
while following
([t3code#17348](https://github.com/pingdotgg/t3code/pull/17348)). The
empty-thread placeholder already clears the composer
([t3code#18331](https://github.com/pingdotgg/t3code/pull/18331)). Project skill
directories are watched
([t3code#16750](https://github.com/pingdotgg/t3code/pull/16750)). Chat markdown
does not subscribe to server config or the connection
([t3code#20852](https://github.com/pingdotgg/t3code/pull/20852)). The Lexical
composer already groups undo
([t3code#14674](https://github.com/pingdotgg/t3code/pull/14674)).

Moved to Phase 2:
[t3code#19869](https://github.com/pingdotgg/t3code/pull/19869) restructures
upstream's ChatView handlers so shared closure scopes stop retaining old
renders. F5's ChatView is built differently, so the port needs a heap-snapshot
measurement first.

Not applicable: 12 React Compiler adoptions (maintenance), and fixes to
upstream-only parts: the composer banner stack (6), the composer surface (2),
the Tiptap composer (2), citation notes (3), the timeline system divider (2),
the chat canvas, the branch toolbar's label collapse, the composer shoulder tab,
the resting composer's floating actions, run continuation, cross-environment
thread drops, and the mobile app.

Validation: the new and touched unit suites (ChatMarkdown, markdown links,
composer logic, session logic, the suggestion id helper, OpenCode runtime,
adapter and text generation) pass, as do the full ChatView (135) and
MessagesTimeline (73) browser suites and the new tooltip browser test. The
tooltip and Windows-path tests fail with their fix removed. The
web and server typechecks and lint pass.

## September set 11a triage log: Usage

All 68 open set 11a records (the 15q carrier) are classified: 46 October
follow-ups and the 22 September members that were waiting on a targeted
comparison. The result is 3 ported, 12 equivalent, 2 declined and 51 not
applicable. The 22 September members change only in the ledger and keep their
`11a` id; the September plan stays the original review.

New ports:

- [t3code#11922](https://github.com/pingdotgg/t3code/pull/11922): the macOS app
  declares `NSLocalNetworkUsageDescription`, so macOS 15 can explain its prompt
  before F5's terminals and agents reach local network hosts.
- [t3code#12799](https://github.com/pingdotgg/t3code/pull/12799): a Grok
  account with nothing metered yet shows a 0% meter instead of claiming its CLI
  cannot report limits.
- [t3code#6670](https://github.com/pingdotgg/t3code/pull/6670): an unknown
  system time zone buckets usage in UTC instead of failing the summary.

Most of the set does not apply because F5's Usage is a different design. Its
Activity counts only turns F5 ran, from SQLite facts, so the 20 fixes to
upstream's provider history scanners and their cache have nothing to act on.
F5 has no model rate table (5 fixes), and its dashboard is its own layout (6).
It runs one environment and never merges accounts by email (3), redeems reset
credits only through the Codex app server (2), and has no scoped RPC auth,
pairing route, cross-version clients, URL-labelled limit sources, Claude
context-usage query or mobile app. Eight are React Compiler or refactor
maintenance.

Equivalent and cited: F5 never reads the macOS Keychain for Cursor
([t3code#13870](https://github.com/pingdotgg/t3code/pull/13870),
[t3code#13714](https://github.com/pingdotgg/t3code/pull/13714)) and reports a
missing Cursor login as unavailable
([t3code#13820](https://github.com/pingdotgg/t3code/pull/13820)). Its countdown
already says "in <1m" in the final minute
([t3code#17869](https://github.com/pingdotgg/t3code/pull/17869)). Accounts keep
separate identities
([t3code#17711](https://github.com/pingdotgg/t3code/pull/17711)), and a hub
yields only its configured account
([t3code#9584](https://github.com/pingdotgg/t3code/pull/9584)). Usage requests
are outside the slow-RPC allowlist
([t3code#9358](https://github.com/pingdotgg/t3code/pull/9358)), and providers
refresh only on request
([t3code#11811](https://github.com/pingdotgg/t3code/pull/11811)). Limits re-read
stale accounts when opened
([t3code#11928](https://github.com/pingdotgg/t3code/pull/11928)). The provider
table lists only providers with usage
([t3code#7563](https://github.com/pingdotgg/t3code/pull/7563)). Account labels
never carry an email
([t3code#10668](https://github.com/pingdotgg/t3code/pull/10668)). Claude's
capabilities are published before its optional usage read
([t3code#9784](https://github.com/pingdotgg/t3code/pull/9784)).

Declined: opening Usage on Limits by default
([t3code#11261](https://github.com/pingdotgg/t3code/pull/11261)), because F5
keeps Activity as the first-visit tab and then remembers the last one, and
pooling limits across accounts
([t3code#10300](https://github.com/pingdotgg/t3code/pull/10300)), because F5
shows each account separately by design.

Validation: the provider limits, usage format and desktop Info.plist unit tests
pass, as do the 41 Usage dashboard browser tests and the server and web
typechecks.

## September sets 11c, 12b and 11 triage log: titles, forges and Grok

The seven September members left in these sets are classified in the ledger
and keep their `11c`, `12b` and `11` ids. The result is 4 ported, 1
equivalent, 1 not applicable and 1 still deferred with part of it ported.

New ports:

- [t3code#8087](https://github.com/pingdotgg/t3code/pull/8087): automatic title
  generation retries a failed request twice with exponential backoff before it
  falls back to the truncated message. Each attempt calls the provider again,
  and an unsupported Codex ChatGPT model goes straight to its fallback model.
  The first backoff is a `ThreadTitleRetryDelay` reference, so tests run it in
  a millisecond.
- [t3code#5941](https://github.com/pingdotgg/t3code/pull/5941): a provider's
  thread name replaces only the default title, never one the user or title
  generation set.
- [t3code#10526](https://github.com/pingdotgg/t3code/pull/10526), server half:
  Claude metadata generation runs with `--permission-mode dontAsk`, so a
  default permission mode in the user's Claude settings cannot change it. The
  other half syncs the title model across connected environments, which F5
  does not have.
- [t3code#11593](https://github.com/pingdotgg/t3code/pull/11593), web parts:
  dialogs and alert dialogs are no-drag, so one over the desktop titlebar keeps
  its clicks, and the model picker tooltip names the model picker shortcut.
  The Forgejo error-body change is declined because F5 keeps forge response
  bodies out of its errors on purpose.
- [t3code#8358](https://github.com/pingdotgg/t3code/pull/8358), approval
  parts: choosing "Always allow this session" when Grok offers no
  `allow_always` option used to send `cancelled` and end the turn. It now
  approves once, and the adapter remembers that exact operation for the
  session; a different command still asks, and computer-use requests are never
  remembered. Supervised sessions start Grok with `--permission-mode default`,
  so an always-approve in the user's Grok config cannot skip the prompts.

Equivalent: large Azure DevOps pull request lists
([t3code#8572](https://github.com/pingdotgg/t3code/pull/8572)) were an az CLI
output cap; F5 calls Azure DevOps over REST and already reads up to 16 MiB per
response. Not applicable: slow forge CLI discovery probes
([t3code#6223](https://github.com/pingdotgg/t3code/pull/6223)), because F5
detects forges from remote URLs and runs no CLI probes.

Still deferred from t3code#8358: the Grok turn inactivity watchdog (about 300
lines of race-sensitive liveness state that F5's shared Grok, ACP and
Antigravity adapter would need adapted, not copied), capturing Grok's native
plan mode as a proposed plan, reasoning effort through `session/set_model`
metadata, and the ACP tool-content bounding and coalescing changes, which are
not compared yet.

Validation: the Grok adapter tests fail without the fix (both turns end
`cancelled`), as does the dialog test without `no-drag`, the model picker
tooltip test without the shortcut, and the Claude text generation suite
without `dontAsk` (18 failures). The 11 suites that use the mock ACP agent
(191 tests), the title and reactor suites, and the server and web typechecks
pass.

## September set 13b triage log: browser preview

All 88 open set 13b records are classified: 57 October follow-ups and 31
September members, which change only in the ledger and keep their `13b` id.
The result is 7 ported, 17 equivalent, 60 not applicable and 4 deferred.
Most of the not-applicable records belong to upstream subsystems F5 does not
have: the floating picture-in-picture preview, the browser that runs on the
environment server, remote environments, scoped RPC auth, display-capture
recording, Electron 43 and the mobile app, plus 19 React Compiler and
memoization refactors.

New ports:

- [t3code#14573](https://github.com/pingdotgg/t3code/pull/14573): a download
  from a preview tab the agent is driving saves to `preview-downloads` in the
  owning profile's state directory instead of opening a native Save dialog over the whole app.
  A download the user starts keeps the dialog. After review, each agent download is capped at
  256 MiB and the folder keeps its 50 newest downloads, so a page cannot fill the disk.
- [t3code#16961](https://github.com/pingdotgg/t3code/pull/16961), in part:
  preview sessions had no permission handler, and Electron approves every
  request then, so any page could read the clipboard, post notifications, ask
  for location, camera or microphone, or launch an app through a custom
  scheme. Preview sessions now allow only clipboard writes and fullscreen,
  which is stricter than upstream, and a page's fullscreen fills its own
  webview. The shortcut forwarding and tab selection parts stay deferred.
- [t3code#9068](https://github.com/pingdotgg/t3code/pull/9068): every preview
  CDP use goes through one pinned Debugger per guest, so garbage collection
  cannot crash the app while it is attached
  ([electron/electron#53376](https://github.com/electron/electron/issues/53376)).
- [t3code#13559](https://github.com/pingdotgg/t3code/pull/13559) and
  [t3code#10232](https://github.com/pingdotgg/t3code/pull/10232): when no
  desktop window can host the preview, or agent browser access is off, the
  preview tools tell the agent not to retry and to check the page from the
  shell instead. `preview_snapshot` accepts `includeImage=false`.
- [t3code#13395](https://github.com/pingdotgg/t3code/pull/13395): checkpoint
  capture no longer stamps the copied Git index one second early, which made
  Git reread every file from the preceding second.
- [t3code#19365](https://github.com/pingdotgg/t3code/pull/19365): a project
  action shortcut recorded in a browser client is saved, not dropped.
- [t3code#15628](https://github.com/pingdotgg/t3code/pull/15628): the file
  view's read error names the attempted path and workspace folder.

Equivalent, among others: F5 types into preview pages through the guest's own
`insertText`, never CDP, so agent typing cannot land in the app
([t3code#18556](https://github.com/pingdotgg/t3code/pull/18556)); it probes
only URLs printed by processes it owns
([t3code#16687](https://github.com/pingdotgg/t3code/pull/16687)); a preview
timeout fails only its request, never the host connection
([t3code#17693](https://github.com/pingdotgg/t3code/pull/17693),
[t3code#12535](https://github.com/pingdotgg/t3code/pull/12535)); and its
session cookie is `SameSite=Strict`
([t3code#18509](https://github.com/pingdotgg/t3code/pull/18509)).

Deferred: agent cursor and input feedback drawn into recordings
([t3code#12779](https://github.com/pingdotgg/t3code/pull/12779)), favicons on
browser tool activity rows
([t3code#11032](https://github.com/pingdotgg/t3code/pull/11032)), and handing
focus back after an agent click
([t3code#15008](https://github.com/pingdotgg/t3code/pull/15008)), which needs
a desktop run to confirm F5 has the problem.

Validation: the 102 desktop preview tests, the 44 preview MCP tests, the
checkpoint store, project script keybinding and file view suites, and the
server, web and desktop typechecks pass. Electron cannot launch in this
environment, so the download, permission and debugger changes were checked by
unit tests and typecheck only, not in a running desktop window.

## September set 12a triage log: pull requests

All 192 open set 12a records are classified: 102 October follow-ups and 90
September members, which change only in the ledger and keep their `12a` id.
The result is 4 ported, 16 equivalent and 172 not applicable. F5's PR hub
(`apps/web/src/components/prHub`, `apps/server/src/prHub`) shares no code
with upstream's pull request pages, `PullRequestService` or sync reactor, so
83 upstream layout and control fixes and 33 service changes have nothing to
land on. The rest are 32 React Compiler and memoization refactors, 4 moves of
forge providers into their own packages, the mobile app, CI and contributor
housekeeping, and a handful of thread-link fixes for upstream behavior F5
does not have: F5 links a PR to a thread only through an explicit command and
never infers one from a branch.

New ports:

- [t3code#7588](https://github.com/pingdotgg/t3code/pull/7588): importing the
  GitHub CLI login with a `gh` older than 2.81.0, which rejects
  `auth status --json`, now asks for an update instead of reporting a generic
  read failure.
- [t3code#11994](https://github.com/pingdotgg/t3code/pull/11994): Cmd/Ctrl+Enter
  prepares the timeline comment preview and posts a review thread reply. A
  comment still needs its confirm step, and the shortcut is ignored while an
  IME is composing.
- [t3code#15876](https://github.com/pingdotgg/t3code/pull/15876): an explicit
  Bitbucket repository that is not `workspace/repository` is refused before
  any request. Before, `repo` was requested as `/repositories/repo`, which
  Bitbucket answers with a workspace listing.
- [t3code#15057](https://github.com/pingdotgg/t3code/pull/15057) was already
  ported in 15h as PR watches and is now recorded against that work.

Equivalent, among others: PR diffs already honor the whitespace setting while
file stats keep the forge's totals
([t3code#12438](https://github.com/pingdotgg/t3code/pull/12438),
[t3code#16162](https://github.com/pingdotgg/t3code/pull/16162)); every forge
request, Bitbucket included, times out after 30 seconds
([t3code#14140](https://github.com/pingdotgg/t3code/pull/14140)); a forge PR
reads as conflicting only from `has_conflicts`
([t3code#15441](https://github.com/pingdotgg/t3code/pull/15441)); and only
pull request URLs open the in-app preview, so issue links cannot strand it
([t3code#14242](https://github.com/pingdotgg/t3code/pull/14242)).

Validation: the GitHub CLI import, forge source control and PR hub composer
and review thread suites pass, and each new test failed before its fix. The
server and web typechecks pass.

## September sets 13a, 3e and 13d: single carried records

The three single records carried by 15s and 15o are not applicable. F5 preview
tabs have no selectable browser profiles
([t3code#9279](https://github.com/pingdotgg/t3code/pull/9279)), F5 has no Codex
citation renderer whose links could lose backslashes
([t3code#12243](https://github.com/pingdotgg/t3code/pull/12243)), and F5 shows
SnapShots as ordinary image attachments, with no SnapShot frame to widen
([t3code#11429](https://github.com/pingdotgg/t3code/pull/11429)). The other two
`13d` members stay deferred, as planned. The `2`, `10` and `14` records with
September implementation notes stay held by the open performance and
distribution release gates.

## 15m triage log: threads without a project and new projects

All 14 records are closed. Six are ported and eight are not applicable.

Threads without a project
([t3code#13612](https://github.com/pingdotgg/t3code/pull/13612)) are ported in
four commits:

- A reserved `scratch` project kind. Each profile has one, with a
  deterministic id, created by the idempotent `projects.ensureScratch`. It
  lives at `<stateDir>/scratch` and is refused when that folder is inside a
  Git checkout. Each thread gets its own `scratchPath` folder, named
  `<date>-<first words>-<id8>`, when it is created. The decider rejects
  deleting the scratch project, changing its folder, actions, memories or
  skills, and giving its threads a branch or worktree.
- One resolver, `threadWorkspaceCwd` in
  `packages/shared/src/threadWorkspace.ts`. It returns the scratch folder,
  then the worktree, then the project root. A scratch thread without a folder
  resolves to nothing, never to the shared root. Every server and web workspace
  decision now goes through it. `scripts/thread-workspace-guard.test.ts` parses
  the sources and fails on a new fallback from a worktree path to anything
  else, with each remaining fallback allowlisted and given a reason.
- Containment. A request naming a folder below the scratch root must stay
  inside one thread folder, and Git methods are refused there. Project-scoped
  workspace assets do not resolve for the scratch project. This scopes access
  that goes through F5. It does not sandbox a provider's shell. Git consumers
  skip scratch threads: steer readiness, default-branch auto-pull, PR checkout
  discovery, and the chat view's status, branch, diff and branch toolbar
  queries. Checkpoints already stop at folders that are not repositories.
- Entry points. The empty sidebar and home offer "or start without a
  project", the command palette has "New thread without a project", its "New
  thread in..." picker leads with "No project"
  ([t3code#16628](https://github.com/pingdotgg/t3code/pull/16628)), and
  `chat.newScratch` ships unbound. The scratch project still holds its threads
  in the sidebar, with only "Settle idle threads" in its menu. It is left out
  of project pickers, Settings, provider inventory overrides and workflows.
  Usage groups its threads under its title, "No project".

Also ported:

- Without a git binary, the scratch root counts as outside any checkout, so
  these threads need no Git
  ([t3code#17959](https://github.com/pingdotgg/t3code/pull/17959)).
- F5's PR hub has no project filter. Its local checkout candidates now skip
  the scratch project
  ([t3code#19179](https://github.com/pingdotgg/t3code/pull/19179)).
- A new project can be created from just a name
  ([t3code#14527](https://github.com/pingdotgg/t3code/pull/14527)).
  `projects.createNew` reserves `<projectsRoot>/<slug>`, adding `-2`, `-3` and
  so on with a non-recursive mkdir when the name is taken. `projectsRoot`
  defaults to `~/f5-projects`, or `~/f5-projects-<profile>` outside the default
  profile, and can be changed in Settings > Projects. The new folder gets a
  README and a `.gitignore`, then `git init` and a first commit with the Git
  author from Settings. If Git fails, the folder is kept and the user sees a
  warning. The first thread opens in the main checkout
  ([t3code#17371](https://github.com/pingdotgg/t3code/pull/17371)).

Not applicable:

- Two React Compiler refactors
  ([t3code#20673](https://github.com/pingdotgg/t3code/pull/20673),
  [t3code#20589](https://github.com/pingdotgg/t3code/pull/20589)).
- Four multi-environment follow-ups
  ([t3code#14759](https://github.com/pingdotgg/t3code/pull/14759),
  [t3code#17050](https://github.com/pingdotgg/t3code/pull/17050),
  [t3code#15356](https://github.com/pingdotgg/t3code/pull/15356),
  [t3code#17022](https://github.com/pingdotgg/t3code/pull/17022)), because F5
  runs one environment.
- A contributor list change
  ([t3code#13353](https://github.com/pingdotgg/t3code/pull/13353)).
- Publishing a new project to a forge
  ([t3code#17860](https://github.com/pingdotgg/t3code/pull/17860)), because F5
  has no repository publishing flow.

Validation:

- The server, web and contracts typechecks pass.
- Server suites pass for orchestration, project, nextTurnQueue, git, provider,
  checkpointing, prHub and wsServer.
- The web unit suite passes, as do the ThreadSidebar, ChatView, DiffPanel,
  FileViewPanel, Settings, Home and new-project dialog browser suites.
- The workspace guard and the shared resolver tests pass.
- The slug test failed on accented names until combining marks were stripped.
- The final full run found that a project written without a `kind` could not
  be stored, which broke the Codex control client and MCP runtime suites. The
  repository now stores it as a standard project, and a repository test covers
  the case.

## 15n triage log: prompt links

Both records in the ledger's range are closed as not applicable. They are
React Compiler refactors of upstream's prompt link page and hosted landing
([t3code#20559](https://github.com/pingdotgg/t3code/pull/20559),
[t3code#20712](https://github.com/pingdotgg/t3code/pull/20712)). The feature
they refactor is the approved 15n plan item, which F5 now implements in four
commits:

- Parsing and sanitizing, in `packages/shared/src/promptLinks.ts`. Prompts are
  capped at 8,000 characters. Zero-width, bidi, tag and other invisible
  characters are removed, and the user is warned about them. A prompt made
  only of such characters is refused. `promptLinkAppPath` maps only `new` and
  `thread/<id>` to app routes. It refuses dot segments and thread ids that name
  one of the app's own screens, so a link cannot reach Settings.
- The web side. `/new` puts the prompt in a new draft. With no repository it
  uses a thread without a project. With a repository it uses the most recently
  used project whose GitHub remote matches, found by the new
  `projects.findByRepository`. When none matches, it offers Clone (showing the
  full URL) or Use without a project. A pull request link opens the thread that
  already tracks it, or checks it out in a new worktree after the user
  confirms. `/<thread>?prompt=` fills that thread's composer and asks before
  replacing a draft. The provider and model apply only when that provider is
  set up. A link never sends a message. "Copy prompt link" is in the palette
  and on user messages.
- The desktop side. F5 registers `f5://`, and development builds register
  `f5-dev://`. Packaged builds declare the scheme at install time. Links arrive
  through `open-url` or the command line, wait in the main process until a
  window takes them (so a cold start loses nothing), and open in the profile in
  use. With more than one profile, F5 names the profile the link opened in.

Also ported, from past the ledger's last interval: a new-thread link opened
from a thread no longer lands in that thread
([t3code#19326](https://github.com/pingdotgg/t3code/pull/19326)). During a
pending navigation the router already reports `/new` while the thread is still
mounted, so the thread route now handles a prompt only on its own path.

Validation:

- The shared, web, desktop, contracts and scripts typechecks pass.
- The prompt link unit tests pass, as do the browser tests for the `/new`
  view, the thread link hook and the desktop link controller. The desktop inbox
  tests and the server `projects.findByRepository` test also pass.
- The #19326 test failed before the fix: the leaving thread's composer received
  the prompt.
- `f5://thread/../settings` resolved to Settings until dot segments and reserved
  routes were refused.
- The desktop app was not launched. Dev Electron does not start in this
  environment, so the OS handoff (`open-url`, second instance) is covered only
  by unit tests.

## Third and fourth reviews: known limits left as documented

These findings stay as they are, with the reason recorded here.

- HTML renders and MCP apps in a plain browser. The frame CSP limits what a
  page loads, not where it navigates. The desktop app blocks a `srcdoc` frame
  from navigating anywhere else (`appFramePolicy`, now keyed by frame identity
  so a fragment change no longer escapes it). A browser offers no such hook, so
  there a page can still leave with its contents in the URL. Rendering with
  `sandbox=""` in browser builds would remove the interactivity these frames
  exist for. The limit is noted in both frame components and in the "Load
  remote images in chat" description, which used to read as "no network
  access".
- Checkpoints keep rewritten history reachable. A checkpoint commit records
  HEAD at capture as its parent, so `refs/t3/checkpoints/*` keeps a commit that
  was later amended or reset away, for example one holding a secret, alive
  through `git gc`, and `git push --mirror` would publish it. The refs go when
  storage maintenance purges a deleted or archived thread, and when a rewind
  prunes them. Release notes should say this; to drop such a commit sooner,
  delete or archive the thread and run storage cleanup, or delete the refs.
- Scratch folders stay under the state directory. Provider shells are not
  sandboxed, so a full-access agent can read the state directory from any
  folder, not only from below it; moving the root would not change that, and
  it would need a migration of existing folders. Deleting a thread now removes
  its folder.
- Packaged backend startup. The backend's `--require` of `compileCache.js` is
  now added only when the file is packaged. The backend entry is loaded from the
  same asar, so asar resolution in run-as-node mode is already required for the
  backend to start at all. The packaged smoke test has still not been run.
