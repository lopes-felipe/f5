# Agent browser and computer use: certification and validation

Validation records and remaining release work moved from [agent-browser.md](../agent-browser.md).

## Certification and validation

### Clustered certification coordinator

The coordinator groups checks into automated readiness, workflows/consent/isolation,
protection/capture/displays and recovery/permissions, with separate built-in and Chrome
tracks. It never changes release flags. Use a new directory outside the checkout:

    bun run computer:certify prepare --output /tmp/f5-certification-suite \
      --platform darwin --provider both \
      --codex-home <selected-profile-codex-home> --codex-binary <codex-cli> \
      --claude-home <selected-profile-claude-home> --claude-binary <claude-cli>
    bun run computer:certify run --output /tmp/f5-certification-suite --group automated
    bun run computer:certify run --output /tmp/f5-certification-suite --group workflows
    bun run computer:certify report --output /tmp/f5-certification-suite

Development preparation builds the app bundles before pinning them, then compiles the
five native fixture executables once, verifies their read-only status protocols, observes the suspended
helper's permissions and display geometry, and checks each configured provider's own
account scope. It sends no grant, permit, resume, capture or input. The private launch
configuration contains selected paths but is omitted from coverage reports.
The --app option selects an installed target; --helper cannot replace that
target's bundled helper. Specifying --platform win32 --arch x64 prepares the Windows
inventory on another host without pretending its software or machine checks ran on
Windows. A new suite must be prepared on the actual Windows machine.

Windows preparation now builds a separate Rust/Win32 synthetic fixture with native
editable/password controls, a button and granted/ungranted capture markers. Shaped
and layered click-through modes provide owned recipient fixtures. Its default command
refuses to open a window: only explicit `--run` may do so, and `--check` reports fixed
metadata without creating windows, capturing, requesting access or posting input.
Stdin accepts only status and closure of that fixture's own window. Receipts contain
bounded counters and an exact-synthetic-Unicode boolean, never field contents.
The fixture source, Cargo manifest/lock and prepared binary are included in identity
hashes. Hosted Windows readiness builds/tests it and invokes its metadata-only branch.
Cross-target compilation and portable receipt tests do not establish UIA behavior,
recipient safety, capture alignment or real input delivery. The interactive Windows
driver and cloaked/elevated/packaged-app, composition and monitor scenarios still need
implementation and execution on an interactive machine; preparation grants no proof
for those coverage rows.

The hosted Windows storage failure also exposed a SQLite adapter issue: its normal
zero-column execution used `StatementSync.run()`, which stops after one intermediate
step of `incremental_vacuum(N)`. The adapter now drains normal/positional execution
with `all()` while retaining its empty public result and raw write metadata. Real
SQLite regressions fail on the original adapter and pass on the fix; the existing
bounded vacuum/page-count assertions and native interruption thresholds are unchanged.

For the repeated Linux historical-timeline assertions, the exact CI source passed
the isolated and complete 687-test browser suite in a Linux container. A controlled
stale anchor reproduced the missing historical row and plan button; resetting only
the reused browser fixture thread's module-level anchor made both pass. The full-app
test setup now resets that state along with localStorage and its other stores. No
production timeline behavior or assertion changed. Hosted CI subsequently confirmed the
fix in the quality/browser job and the SQLite fix in the Windows job at
[910d42e18b](../computer-certification/2026-10-13-ci-910d42e18b-passed.json).
Those software passes do not establish native input/capture or installed-build safety.

Before input, current permission/account prerequisites and all executable identities
are checked again. In a terminal, the runner waits for READY. An orchestrating agent
may use --operator-ready only after an explicit, current human readiness response;
it is never app consent. Each provider still receives genuine native app consent.
The workflow runner's --cluster-workflows mode requests only the synthetic fixture,
TextEdit and Calculator, then uses one provider session for fixture/UI controls and
the real-app sequence. Fixture and real-app phase results remain separate. A failed
fixture phase prevents the real-app phase. A failed later phase does not erase completed
earlier proof when cleanup is confirmed.

The separate `chromium-workflow.<provider>` phase uses a suite-owned Electron app,
not the AppKit fixture or F5 itself. Preparation copies the development runtime into
a new synthetic bundle with its own app identity, packages an isolated/sandboxed
preload and static UI, verifies syntax and the copied bundle's ad-hoc signature,
and hashes the whole prepared fixture. It never starts Electron or posts input.
Execution uses a private copy with private user/session data, genuine F5 app consent,
the normal provider/native tools, and trusted DOM receipts for the button and exact
synthetic Unicode value. Receipts contain only fixed labels and booleans; no typed
or password values leave the fixture. The phase also checks Pause/Resume, coordinate
actions and overlays. Ad-hoc fixture signing and fake-DOM receipt tests do not prove
installed F5 signatures, TCC attribution, real accessibility behavior or input delivery.
Those require the separately recorded machine run; no such run is credited yet.

Each scenario admission is reserved before execution and each attempt is written
exclusively. Completed attempts cannot be overwritten. A process-interrupted admission
is failed as outcome-unknown on recovery, without repeating an action:

    bun run computer:certify resume --output /tmp/f5-certification-suite --group workflows
    # Only after inspecting the failure, restoring prerequisites and coordinating again:
    bun run computer:certify resume --output /tmp/f5-certification-suite \
      --group workflows --retry real-apps.codex

To run a single unattempted phase, use --scenario real-apps.codex. Selection does not
retry a prior failed attempt, rerun completed phases or remove missing rows from the
coverage report. Each machine receipt carries a fresh admission identifier and must
match its execution interval, platform, architecture, helper hash and provider. Stop
proof also requires the named clock, input and freeze assertions; arbitrary passing
booleans or a stop measurement cannot override failed workflow assertions.

The [first combined workflow attempt](../computer-certification/2026-10-13-macos-cluster-workflows-attempt.json)
at clean source 9c5ea1562b passed three read-only discovery turns through each provider.
Codex then passed the synthetic fixture actions, genuine Pause/Resume, fresh screenshot,
activity thumbnails and semantic/coordinate overlay checks. The overall attempt failed
before TextEdit input: PID tracking called the native process verifier with --pids,
while its supported metadata command is --status. The seeded test document remained
open, so cleanup was unconfirmed and neither input phase received passing suite credit.
That failed attempt remains immutable. The runner now uses --status, preparation probes
the compiled verifier protocols, and phase selection permits a focused subsequent
real-app run. No release gate changed.

The [focused real-app runs](../computer-certification/2026-10-13-macos-cluster-real-apps-passed.json)
at clean source c43f201351 then passed all 16 checks through each provider, with the
current helper 42e5f28a123a74b947ce93d0962494c497ab5f889fb68f6576c3ceb3793e48c5.
Both used genuine native consent, saved the exact synthetic Unicode document, verified
its closure and Calculator's result independently, and confirmed process/app cleanup.
Each typed once; no failed mutation or ambiguous outcome was recorded. Claude also
made one read-only inspection that returned app-not-running after document closure and
before Calculator launch, then continued. That limitation is retained explicitly: these
passes do not certify strict stop-on-every-tool-error behavior, the wider app/privacy/
profile/display/recovery matrix, Windows or signed installed-build attribution. The
failed combined attempt remains failed; no release gate changed.

The observer now retains failed/ambiguous mutation counts and distinct typing request
counts, so a later success cannot hide a failed action or an accidental typing retry.
Missing or malformed terminal responses leave the trace incomplete. Observation
failures remain separate and content-free. These stronger assertions have regression
coverage; the recorded machine runs above retain their original source and artifact
identities rather than being relabelled as runs of the updated observer.

The [merged-source automated cluster](../computer-certification/2026-10-13-macos-cluster-merged-automated.json)
at clean 42472bb485 passed formatting, lint, typecheck, full tests, the complete browser
suite, desktop smoke, profile lifecycle, Swift tests, tier drift and helper protocol.
It includes the same main-branch changes tested by PR CI and pins the complete Electron
runtime. Packaging remains blocked by deferred signing. Provider homes were deliberately
not configured for this software-only run; its readiness flags are not account-login
results. The earlier remote Windows cleanup assertion assumed a process exit within
20 ms. The test now separates deterministic missing-exit rejection from real process
exit, retaining the actual POSIX nonresponsive-child case; no runtime deadline changed.
The remote browser scroll failure passed both isolated and full local reproductions.
No production scroll change was made. The subsequent hosted run at 910d42e18b passed
all three jobs; the source identities of earlier machine evidence remain unchanged.

The macOS development `windows-closed` phase now has an external observer. It obtains
genuine app consent in the production UI before closing every app window of its owned
F5 instance. The observer then submits one ordinary provider turn through the existing
authenticated loopback orchestration API. It cannot answer consent, change grants or
send native execution/lease messages. The fixture keeps Ready, countdown, RED and
finished instructions visible; Finish check stays enabled until a genuine click is
acknowledged or the phase times out as failed. Only synthetic fixture values are used.

Acceptance requires correlated capture/inspection results, exactly one activation,
semantic press, semantic focus and typing action, plus independent fixture outcomes.
Observation records whether any app window reopened or remained at a mutation
admission. After the turn completes, ordinary session stop must clear grants and the
lease. This stop check does not measure interruption of in-flight input. Missing
responses, extra mutations, lost transport, incomplete cleanup or absent human
acknowledgement cannot pass. All direct-loaded observer dependencies are hashed for
resume. The driver and its fake-transport/receipt tests are prepared. The unsigned real
provider runs below now pass; signed installed windowless proof remains pending.
Select the phase with:

    bun run computer:certify run --output <prepared-suite> \
      --group workflows --scenario windows-closed.claude

The [first Claude windowless attempt](../computer-certification/2026-10-14-macos-claude-windowless-queue-admission-failed.json)
on clean `555aa88116` obtained genuine fixture consent and stopped before native
input, with confirmed cleanup. Inspection exposed a stale driver path: direct
`thread.turn.start` dispatch is refused for established threads by the server's
normal queue-admission gate. The corrected external client submits once through
`nextTurnQueue.submit` with ordinary `auto` intent, verifies the correlated admission,
and refuses direct turn dispatch, bootstrap and queue-order overrides. A lost or
timed-out submission remains outcome-unknown and is never resent automatically.
The existing real-server route regression proves direct-dispatch rejection; new
external-client regressions failed before the correction and pass after it. These
software results do not qualify the unfinished real windowless phase. Transport
failure diagnostics now preserve only fixed unavailable/interrupted/outcome-unknown
labels; the original failed receipt retains its original unknown label.

The corrected windowless phase passed all 21 admitted checks through
[Claude](../computer-certification/2026-10-14-macos-windowless-claude-passed.json) and
[Codex](../computer-certification/2026-10-14-macos-windowless-codex-passed.json) on clean
`a2aa17f3d1`, with the unchanged helper hash. Each run obtained genuine fixture consent,
closed every app window of its suite-owned F5 instance, and submitted exactly one
ordinary queued turn externally. No test-instance app window reopened or was present
at any of the four mutation admissions. Each provider completed exactly one activation,
semantic press, semantic focus and synthetic typing action; correlated capture and
inspection responses and independent fixture button/text receipts passed. Session stop
after completion cleared grants and released the lease; the operator acknowledged
Finish and cleanup was confirmed. Unrelated F5 instances remained open. This proves
unsigned windowless continuity, not signed installed attribution or an in-flight stop
latency bound. The earlier rejected attempt remains failed; no public gate changed.

Use a separately prepared provider phase for Codex. Prerequisites must pass before
readiness or consent; another running development helper holding the device lock
prevents this isolated instance from executing.

Preparation also exposed an executable publication issue while another development
helper was running: the rebuilt helper at its overwritten path exited with SIGKILL
before hello, while a byte-identical fresh copy returned other-instance. The build now
stages a fresh file and renames it into place, preserving an existing process's mapped
file and retaining the prior binary on build failure. The rebuilt original path then
returned other-instance with the same helper hash. This is a development build fix,
not signature/TCC certification. Hosted Windows refused replacement while the test
held the old file open (EPERM). Its regression now requires that explicit refusal,
unchanged old bytes and cleaned staging, then successful publication after closure;
it does not skip the byte-preservation assertions. Hosted Windows CI at edee9ef4ca
passed this regression and its full integration suite; macOS and quality jobs passed
too (see the commit-specific receipt in docs/computer-certification). These are
software checks, not interactive Windows or release certification.
The read-only prerequisite probe also latches its
first terminal result, requires a versioned hello and rejects unexpected crash exits;
late pipe errors cannot turn a validated refusal into misleading availability.

The separate development `grant-memory` phase prepares a consent-only sequence for
each provider: genuinely deny, verify a second request in that turn does not reprompt,
genuinely allow with remembering, revoke the session grant, restart and observe the
remembered grant without a new dialog, forget it, restart again and genuinely deny a
fresh request. It uses only its own synthetic app/project/thread and authenticated
listing/narrowing APIs. It never supplies an access answer; main's native dialog owns
approval and the remembering checkbox. The existing wrapper's ordinary composer and
session-stop path drive all four provider turns.

Admission requires three matched native consent answers, trusted reviews, three
distinct provider-session generations, five completed app resolutions, effective and
remembered grant state checks, pushed revocation/forget changes, no helper mutations,
and confirmed cleanup. Observer summaries retain only enums, booleans and counts,
not grant/session identities or tool content. Sequencing fakes prove no machine or
human-consent gate. Both providers passed the genuine development phase at a5dadb91dd:
three native reviews, three session generations, all five app resolutions and
confirmed cleanup, with no capture or input. The earlier Claude review attempt failed
at the second popup and remains recorded; its original exception was not retained.
Popup observation now targets computer-consent dialogs rather than every dialog and
records only a sanitized failure category. A headless two-dialog reproduction rejects
the old global lookup and accepts the narrowed observation; this does not establish
the original attempt's exact exception.
Expiry, click-tier typing upgrades, stale answers and web-only consent remain separate
missing checks; this phase cannot complete the consent release gate.

    bun run computer:certify run --output <prepared-suite> \
      --group workflows --scenario grant-memory.claude

The separate development `session-actions` phase is also prepared for each provider.
It creates an approval-required thread, verifies that mode before every composer
submission, obtains genuine app consent without remembering, then requests one
activation that the user denies through F5's native session-actions dialog. Admission
requires the correlated NotGranted activity and no native mutation or lease. In a
new turn the user genuinely approves session actions, permitting one activation with
a successful capture. A following turn inspects the fixture and presses its button
once without another session-actions prompt. The fixture's independent press count,
native response trace, matched consent kinds/decisions and provider diagnostics must
agree; unexpected errors or ambiguous mutations stop the phase without retry.
Session stop must clear the grants and lease. A persistent fixture Finish button
remains available until a real unmarked user click, or the phase fails its timeout.

Claude's first development attempt passed genuine app consent and denied session
actions without input, then failed: approved activation returned NotGranted after
the observer saw a second provider-session generation. No lease, capture or input
occurred, and cleanup was confirmed. A read-only diagnostic then observed a
runtime-mode-changed restart between its first two turns, without any consent or
input. Four regression cases reproduce lifecycle/terminal events creating full-access
metadata before a session is bound even when the thread requests approval-required.
Ingestion now falls back to the requested thread mode, while preserving an explicitly
bound session's mode. At clean source cf7b9172a8, the
[fresh read-only diagnostic](../computer-certification/2026-10-13-macos-claude-approval-readonly-continuity-passed.json)
passed three actual Supervised submissions in one session without a restart. The
[Claude session-actions phase](../computer-certification/2026-10-13-macos-session-actions-claude-passed.json)
then passed all 18 admission checks: genuine app consent, denied activation without
input, approved activation/capture, one independently observed next-turn semantic
press, four actual Supervised submissions, and grant/lease cleanup. These results
are scoped to the recorded unsigned build and do not open a release gate.
The harness also explicitly chooses Supervised through the ordinary composer control
and observes the actual submitted modes; configuration alone cannot prove approval
mode. Neither step answers app/session consent. The observer records opaque per-request
session ordinals and only known restart
flags from backend logs, never raw messages, identities or paths. These are diagnostic
hints, not qualifying evidence. The
[Codex attempt](../computer-certification/2026-10-13-macos-session-actions-codex-failed.json)
passed genuine app consent, but its second turn completed without activation reaching
F5 or a session-actions request. It timed out waiting for consent with no lease,
capture or input, and confirmed cleanup. The cause and any additional provider
approval behavior remain unestablished; this attempt stays failed. Neither phase
proves approval reset after a replacement session nor consent
expiry, typing upgrades or the full consent matrix. Installed candidates require
their own observation driver. Neither this phase nor grant-memory can open a gate
alone. Any extra provider approval prompt must also receive a genuine user answer.
Future session-actions attempts additionally record bounded activity-tail counts of
tool starts/completions, failed/declined tools, provider approvals and user-input
requests per opaque turn ordinal. They retain no messages, IDs, arguments, results
or approval contents and do not infer the cause of the preserved failed attempt.
These counts are diagnostics, never a substitute for native or human receipts.
The [instrumented Codex attempt](../computer-certification/2026-10-13-macos-session-actions-codex-provider-approval-denied.json)
also stopped before F5 session consent. Its second turn contains one resolved provider
approval and one failed tool, with no native lease, capture or input and confirmed
cleanup. The operator separately confirmed declining Codex's tool approval before
the F5 dialog. That explains this attempt, not the unobserved decision in the earlier
attempt. The persistent instructions now explicitly distinguish the two stages:
approve only Codex's named F5 tool call first, then follow the allow/deny instruction
in F5's separate native Computer access dialog. Later semantic input may likewise
need a genuine Codex tool approval. No prompt is auto-answered; both attempts remain
failed until a fresh run completes the actual F5 denial/approval checks.
The [fresh attempt with separated instructions](../computer-certification/2026-10-14-macos-codex-distinct-consent-attempt-failed.json)
again completed its second turn with a resolved provider approval and a failed tool
before F5 session consent, with no lease, capture or input and confirmed cleanup.
Its provider approval decision was not recorded, so its cause remains unestablished.
The observer now counts only schema-validated accept, decline and cancel decisions,
with an explicit unknown bucket for missing or malformed decisions. This adds no
prompt contents or authorization behavior and cannot retroactively classify a failed
attempt. No further live retry starts without fresh readiness.
The operator subsequently reported approving Codex's tool call in that attempt;
this is a human report, not a captured transport decision. Before another input run,
the development diagnostic now observes the real computer MCP HTTP endpoint as well
as canonical approval decisions. Its receipts contain only method categories, status,
session-header presence, bounded/decoded flags and known outcome codes. Raw request
and response bytes remain transient, capped at 64 KiB and discarded after decoding;
tokens, arguments, images and error text never leave the observer. Fixed outcomes
distinguish expired MCP sessions, credential refusal, RPC errors and tagged tool
errors without guessing their cause. Tests compare actual HTTP bytes, headers and
callbacks, including a throwing diagnostic sink. The wrapper preserves the production
entry, argv and inherited IPC; it supplies no result, consent or execution permit.
It runs only in the guarded unsigned Codex approval diagnostics, is source-hashed,
and must first pass a read-only live check. It provides diagnostic evidence only;
installed candidates continue to require their separate observation driver.
The [read-only Codex transport diagnostic](../computer-certification/2026-10-14-macos-codex-mcp-transport-readonly-passed.json)
passed on clean source `3df3c60a88`: three approval-required turns, one session,
six successful tool-call HTTP responses, no consent, lease, capture or input, and
confirmed cleanup. A separate other-method 405 response did not prevent these calls;
it does not establish the cause of any previous failure.
The [subsequent session-actions attempt](../computer-certification/2026-10-14-macos-codex-session-actions-recorded-decline.json)
records acceptance of Codex's app-access approval and genuine F5 app consent, followed
by an explicit decline of Codex's activation approval, which the operator subsequently
confirmed was intentional. That activation never reached
the MCP endpoint or F5's session-actions dialog. The phase remains failed because the
planned F5 denial and later allowed action were not exercised. No lease, capture or
input occurred; cleanup succeeded. This decision receipt applies only to this attempt,
not earlier attempts or the operator's earlier report. Neither diagnostic qualifies
public release, and no mutation is retried automatically.

The [fresh Codex session-actions phase](../computer-certification/2026-10-14-macos-session-actions-codex-passed.json)
subsequently passed all 18 correlated checks on clean source `cd8c79d9b4` with the
same helper hash. Four genuine approval-required turns stayed in one provider session.
Codex's named calls were approved; F5's separate session-actions denial returned
`NotGranted` without acquiring a lease or sending input. The subsequent genuine F5
allow produced exactly one successful activation and capture; one independently
observed semantic button press succeeded in the next turn without another F5
session-actions prompt. Stop cleared grants, the operator acknowledged Finish, and
cleanup was confirmed. Both providers now have passing unsigned session-actions
proof. Prior failures remain preserved. This does not qualify signed installed
builds or the remaining independent privacy, recovery and display requirements.

Software validation also reproduced an existing reset-credit refresh race: a valid
retry hint that elapsed before the route checked it dropped the retry entirely.
The separate fix schedules a minimum 50 ms retry through the existing capability
throttle; it keeps the real five-second probe gate. The forced expired-hint regression
fails before the fix and passes after it, alongside all six original cases and their
unchanged exact probe-count assertions. This usage fix also applies when computer use
is disabled and provides no computer-control certification evidence. WebSocket test
connection failures now retain their original cause for complete diagnostics.

The unsigned macOS profile-isolation driver now prepares two disposable F5 profiles,
two separate Codex homes/backends and two distinct synthetic app identities. Its
read-only `profile-readiness` phase performs native metadata turns through both real
provider sessions without grants, permits, capture or input, then stops both sessions.
That phase must pass before scheduling genuine consent. It provides readiness proof,
not contention or privacy release certification.

The `profile-isolation` phase uses ordinary authenticated queue submissions and genuine
app consent in each registered renderer. Both profiles take turns holding the machine
lease while the other makes exactly one activation request expected to return `Busy`.
The holder only activates its fixture and inspects its fixed waiting/released status;
no typing, pointer injection or semantic press is requested. Stopping the non-holder
must leave the active holder's lease intact. A separately spawned, suspended helper
must report `other-instance`. Each IPC channel and authenticated client stream is
observed independently. Acceptance requires positive owner activity/thumbnail receipts
as well as absence of foreign activity, images, grants, thread identifiers and private
titles; foreign lease banners must stay anonymous. Failed or bounded-out observations,
uncertain submissions and unconfirmed cleanup cannot pass. Submission is never retried.

The driver compares credential files in memory before/after and verifies distinct
profile homes and private orchestration snapshots; hashes or credential bytes are not
retained. These checks do not audit every provider filesystem read or prove that an
agent with filesystem access cannot read another directory. The non-holder stop check
proves that lifecycle boundary; deterministic lease tests retain the separate stale
holder-release rejection cases. Instrumentation only observes existing IPC/messages.
It neither answers consent nor manufactures leases, results or helper permits. Driver,
observer, fixtures and receipt validator are source-hashed. Initial live coverage uses
Codex in both profiles; it does not qualify Claude profile-launch isolation, Windows,
signed installed candidates or persistence/capture privacy beyond the measured streams.
The [first real read-only readiness run](../computer-certification/2026-10-14-macos-profile-readiness-69553e2b8c-passed.json)
passed on clean `69553e2b8c`: both actual Codex sessions returned native metadata,
kept private snapshots and unchanged credential files, and stopped with confirmed
cleanup. No access request, lease, capture or input occurred. It does not qualify
contention or thumbnail isolation. The final live phase now enables Finish in the
second/frontmost fixture, and requires both fixtures' press/text receipts untouched.
That updated source needs a fresh suite identity. No passing real profile-isolation
run is recorded yet; no public gate changed.
The [first live consent attempt](../computer-certification/2026-10-14-macos-profile-isolation-second-consent-timeout.json)
allowed the first fixture and timed out in the second consent phase before that
profile sent a native access request. No lease, capture or input occurred and
cleanup was confirmed. The operator reported no second prompt. The exact cause
remains unknown because per-profile pre-host progress was not retained. Failed
receipt checks represent incomplete proof, not an observed disclosure. The driver
now requires both named conversations and composers to be visible before any
consent turn, retains partial consent/IPC evidence on failure, and records only
fixed per-profile turn/mode states and canonical provider approval counts. It
narrows device authority locally before awaiting those diagnostics. These changes
must pass a fresh read-only setup check before another human consent attempt.

The [instrumented read-only check](../computer-certification/2026-10-14-macos-profile-readiness-ccb58fcbaf-passed.json)
passed all eleven admitted checks on clean `ccb58fcbaf`, including both visible
profile chats. The [following live attempt](../computer-certification/2026-10-14-macos-profile-isolation-invalid-arguments.json)
failed before the first app consent: a tool call failed strict argument validation,
with no provider approval request, native access request, lease, capture or input.
Cleanup was confirmed. Sanitized receipts do not retain argument values or the
exact invalid field; they do not establish a transport or authorization defect.
The consent-only prompt now supplies an explicit one-element `apps` array and
required `reason`. Validation remains strict, consent remains genuine and failed
invocations are never retried automatically. Full isolation validation remains
pending; neither this failure nor metadata-only success qualifies release.

The [next consent/contention attempt](../computer-certification/2026-10-14-macos-profile-isolation-owner-wait-timeout.json)
on clean `b5d9d6d8cd` received both genuine app consents without remembering.
It timed out waiting for the first owner's lease before any activation, capture
or input. The provider turn remained running, without a recorded tool call or
approval request; cleanup was confirmed. This does not establish the reason for
the provider delay. Owner admission now uses the existing 150-second provider-turn
budget instead of 30 seconds, and fails early if the turn ends without a lease.
This wait measures provider progress, not native stop latency. Fixed queue
dispositions and completed backend/device prerequisites are retained on failure;
contention and privacy assertions remain unchanged. The failed attempt remains
failed and release gates remain closed.

The [following attempt](../computer-certification/2026-10-14-macos-profile-isolation-paused-owner.json)
on clean `d199e2611e` received both genuine consents and verified the second-helper
device lock. It observed one owner lease and an anonymous foreign-profile banner,
then an `Interrupted(paused)` activation result without successful capture or input.
The harness failure code was `unknown`; failure cleanup pauses locally before
collecting diagnostics, so this result alone does not identify the original pause
cause. Cleanup was confirmed. Missing positive owner image/action receipts prevent
acceptance despite no observed foreign data. The attempt remains failed.
Observation-only diagnostics now retain helper physical-input, kill-chord,
permit-expiration and unhealthy-heartbeat counts against a post-consent/countdown
baseline. The owner-ended-without-lease harness error has its own fixed code.
Neither change alters authorization, consent, helper input or stop behavior, and
neither is evidence about this older attempt. No automatic retry or public gate
change follows from these diagnostics.

The operator subsequently confirmed staying idle through RED. An automated
regression demonstrated a separate runner race: the host lease and provider turn
projection are independent asynchronous reads. A lease acquired between those
reads could be cleaned up based on a terminal projection and the stale no-lease
observation. The runner now rechecks the live lease before that failure. The
regression fails with the old predicate and passes with the recheck; terminal
turns without a live lease still fail, and old terminal turns remain ignored.
This establishes a runner defect, not the cause of the older `unknown` failure.
Its result and release status remain unchanged. Production pause/authorization
paths and the subsequent contention/privacy assertions are unchanged.

The [next instrumented attempt](../computer-certification/2026-10-14-macos-profile-isolation-poll-budget-exhausted.json)
on clean `ab0a5c3575` completed both consents, the lock check, owner activation and
capture, and positive owner IPC/client thumbnail delivery. The owner finished all
40 inspection polls before the contender activated, so the latter legitimately
acquired the released lease. The real `Busy` requirement failed; sequential
successes are never accepted as contention. Monitor signal counts remained zero
after the baseline and cleanup was confirmed. No foreign data was observed;
complete two-owner image/isolation acceptance remains pending.
The driver now first starts the contender's genuine, granted-app inspection loop,
waits for a correlated accessible reply, and only then starts the owner. After a
live owner lease is observed, fixture-owned instruction text cues the contender's
ordinary activation call. Both inspection loops are sequential and capped at 200;
an exhausted budget cannot pass. No tool reply, grant, lease or permit is injected
or delayed. The 60-second idle release and all authorization/stop rules remain
unchanged. Bounded observation capacities cover the larger phase (1024 admitted
requests per profile, 2048 aggregate/transport receipts, 4096 IPC messages); any
overflow still fails. Other rehearsal defaults remain 128 requests/receipts.

The [synchronized attempt](../computer-certification/2026-10-14-macos-profile-isolation-unclassified-polling-failure.json)
on clean `813547c1ab` completed both consents, the lock check and 18 contender
inspections, then failed with an unclassified runner error before any lease,
activation or capture. Monitor counts stayed zero and cleanup was confirmed.
Live retries are deferred until the failing path is identified. The unsigned Node
runner now enables source maps and records only allowlisted rehearsal filenames
and bounded source coordinates, never raw error messages, function arguments or
absolute paths. Read-only readiness also exercises the exact bundled owner-polling
path against completed metadata turns, requiring no-lease refusal in both profiles.
It cannot acquire a lease or supply execution results. These diagnostics neither
qualify the older failed attempt nor change public gates.
The completed-turn check passed on clean `cdd577b1db` with no consent, lease or
input and confirmed cleanup. Read-only readiness now also submits the two profiles'
metadata turns concurrently and exercises the same polling while they run. Exact
one-per-profile app-list receipts remain required. This is an input-free diagnostic,
not a retry of any mutation or passing contention evidence.
The [concurrent metadata diagnostic](../computer-certification/2026-10-14-macos-profile-concurrent-metadata-passed.json)
passed all eleven admitted checks on clean `6b8b42a786`, with both polling paths
exercised, zero consent/lease/capture/input, unchanged credentials, stopped sessions
and confirmed cleanup. It did not reproduce the fixture-inspection failure; that
live gate remains pending diagnosis. No further RED retry is scheduled from this
metadata result.

`profile-inspection-diagnostic` is a separate, operator-coordinated unsigned
macOS/Codex phase. It requires genuine consent for each synthetic fixture, then
concurrently inspects them twenty times in plan mode while exercising the same
owner-polling path. It requests no activation, capture or input, and the broker's
plan-mode mutation veto stays active. The operator may use their computer and
should leave the fixtures unchanged; no RED or physical timing cue is needed.
Acceptance requires positive correlated inspections in both profiles, verified
plan mode, no lease/input/activity/images, private snapshots, unchanged credentials,
cleared grants, stopped sessions and confirmed cleanup. Mapped error locations are
retained on failure. This diagnostic has no release-coverage requirements: it cannot
qualify contention, image isolation, stop latency or a tested mutation veto.

The [first inspection diagnostic](../computer-certification/2026-10-14-macos-profile-inspection-diagnostic-failed.json)
on clean `7e7d44f8e7` reproduced the failure after eighteen successful inspections
in one profile; both genuine fixture consents settled. The source-mapped failure
originates at the Electron observation-snapshot evaluation boundary. No lease,
capture or input was observed, and cleanup was confirmed. Failure cleanup subsequently
interrupted pending observation work; that interruption is not the original fault.
Standalone Electron replay of the sanitized snapshot and larger synthetic snapshots
succeeded, so serialization or a provider fault has not been established. New
diagnostics distinguish a thrown observer callback from fixed evaluator transport
categories without keeping raw exception text. This attempt remains failed and
grants no release credit; another full control run is pending diagnosis.

The [boundary-instrumented attempt](../computer-certification/2026-10-14-macos-profile-inspection-context-loss.json)
on clean `de494e90d4` reported `electron-context-lost` after four successful
inspections in one profile. Both consents settled; no lease, capture or input was
observed, and cleanup succeeded. No observer-callback failure was recorded.
Playwright rewrites some underlying protocol failures into context-loss errors,
so this category does not establish a navigation or provider failure. The
diagnostic now transfers the complete sanitized observer snapshot as JSON,
bounded to 512 KiB, avoiding nested CDP object serialization. Oversized, cyclic
or missing results fail closed, and all receipt checks remain intact. Its
unit round trip includes full-budget traces and negative isolation flags;
that fake transport check does not qualify the real profile gate.

The [real JSON-transfer diagnostic](../computer-certification/2026-10-14-macos-profile-inspection-json-passed.json)
passed on clean `5a40c2fcb5`: both profiles completed twenty correlated accessible
fixture inspections after genuine consent, with plan mode verified. No lease,
capture, input, activity or foreign data was observed; credential comparisons
passed, both sessions stopped, grants cleared and cleanup completed. The complete
single-worker test suite also passed, including all 136 exhaustive Git cases.
A preceding two-worker run encountered a WebSocket 403 in a server test; its log was
retained, and no authentication assertions were changed. This pass supports the
new observation-transfer path but does not prove the precise earlier context-loss
cause. The diagnostic carries no release credit and opens no gate; real
contention and positive capture/privacy evidence are recorded separately below.

The [subsequent full isolation attempt](../computer-certification/2026-10-14-macos-profile-isolation-validator-limit-failed.json)
on clean `33add63096` reached real contention in both directions, positive owner
thumbnails on both IPC and client streams, anonymous banners and no observed
foreign data. It failed at final receipt validation: one profile's complete
trace exceeded the stale 128-operation validator limit, despite the observer
admitting 1,024 operations for the bounded 200-poll owner and contender loops.
The final local receipt was not saved before rejection, so remaining invariants
cannot be reconstructed completely; the attempt stays failed with no release
credit. Cleanup was confirmed. Observer and validator budgets now share one
hashed constant; overflow and unexpected operations still fail, including move
and scroll. The driver saves its final receipt before validating it. Regression
coverage includes long valid traces, the exact cap, overflow and extra actions.

The [fresh full isolation phase](../computer-certification/2026-10-14-macos-codex-profile-isolation-passed.json)
passed on clean `ba7e34bfff`, with two real isolated Codex profiles and genuine
fixture consent. Both directions produced exactly one `Busy(other-profile)`
while the other holder remained active. Each owner delivered a positive thumbnail
on its own IPC and authenticated client stream; the other profile received only
anonymous lease state, with no observed foreign activity, image, grant or private
identity. Stopping the non-holder preserved the holder; turn/session cleanup
released leases and cleared grants. Credential-file comparisons and private
snapshots passed, a second helper refused the device lock with `other-instance`,
fixtures received no press or typing, the operator acknowledged Finish, and all
owned resources closed. Traces remained complete with no pending response.
Formatting, lint, typecheck and full tests passed, including all 136 exhaustive
Git cases. This is scoped unsigned macOS/Codex two-profile evidence, not an audit
of arbitrary credential reads, cross-provider contention or signed installed
behavior. Earlier failed attempts remain failed; public gates stay closed.

Development backends inherit stdio. The diagnostic observes Electron's parent output
pipes separately and drops everything except allowlisted lifecycle/restart labels;
watching a child's absent stdout pipe produced no diagnostic evidence. The new
approval-mode read-only diagnostic performs three metadata turns without app consent,
capture or input. It is not a qualifying release phase.

    bun run computer:certify run --output <prepared-suite> \
      --group workflows --scenario session-actions.claude

Resume checks helper, provider binaries, desktop/server bundles, every served client
asset, Electron runtime, prepared fixtures, source hashes, architecture and target identity.
Installed identity covers the whole app, including frameworks and DLLs outside its
Resources directory. Framework aliases are hashed without recursive traversal and
must resolve inside the app; escaping or malformed links are refused. Changed
identity requires a new suite. A live runner lock cannot be stolen. Cleanup requires
actual process/document receipts; sending a signal alone does not qualify. Failed
cleanup or uncertain receipts halt execution before another input phase. Recovery
ordering keeps permission revocation last.

Coverage retains every required scenario, including those without a qualifying driver.
Current executable drivers cover automated checks, macOS provider discovery, clustered
fixture/real-app workflows, native capture/protected-app checks and physical-stop
rehearsals. The new windowless and remembered-grant drivers still need real provider/
machine validation. Remaining grant-lifecycle/profile/persistence observers, the complete
recipient/system-surface/display/recovery/permission matrix, Windows interactive drivers
and installed-app observation still need implementation and machine validation; they
are explicitly blocked, never credited from unit tests. Installed targets do not use
the development Electron wrapper. Signing stays deferred. Current unsigned stop reports
remain historical evidence and are not imported or repeated merely to populate a suite.

Only a clean installed target with both providers, signatures, complete installed
machine evidence, remote CI and security-review proof may report native release
readiness. Even then, gate activation is a separate reviewed change. The coordinator
currently has no path to manufacture these missing approvals or integration proofs.

The October 13 integration recheck still found Claude's interactive-only computer
launch and ChatGPT-managed Codex computer/Chrome runtimes. OpenAI's
[hook documentation](https://learn.chatgpt.com/docs/hooks) documents callback failures
that can allow execution and specialized paths outside hook coverage; hooks alone
do not establish F5's required veto. Claude's
[computer-use documentation](https://code.claude.com/docs/en/computer-use) excludes
non-interactive SDK use. Built-in and Chrome gates remain closed.

No signed-build certification is claimed. Native platform flags, provider built-in
records and Chrome descriptors remain closed until the tests below pass. Hosted CI and
unit tests do not establish TCC attribution, consent integrity, capture isolation or real
stop latency. Record build hash, OS/arch, helper signature/team, permission identity,
provider/installed version, app/action matrix, measurements and proving artifacts.

| Original release requirement                             | Required signed-machine proof                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Per-app consent cannot be widened by the agent        | Trusted user consent, blocked/F5 rejection, web-only read-only card, incarnation mismatch, grant/revoke/forget and restart checks                  |
| 2. Stop input in under 100 ms                            | Key-logging test app under sustained input; repeat with renderer hung and backend stopped; chords must not trigger system actions                  |
| 3. Input never reaches F5/system dialogs                 | Mid-type focus/dialog changes, protected password fields, cross-F5 drag, terminal without typing, elevated Windows owner and semantic action tests |
| 4. Ungranted/F5 content never appears in captures        | Moving windows, notifications, Dock/Start/tray, packaged Windows apps, secure fields and overlays on both monitors/fullscreen Spaces               |
| 5. Permission failures are surfaced without silent retry | Revoke Accessibility/Screen Recording, SCK decline, periodic re-prompt and helper/main attribution mismatch                                        |
| Signed packaging                                         | Universal macOS helper signature/notarization and Windows signature verification; installed helper path confined to resources                      |

Run each provider through TextEdit/Notepad, Preview/Calculator, an Electron semantic
workflow and a multi-app workflow. Include mixed-DPI monitors, rotation/negative origins,
physical-input pause/resume with fresh geometry, multiple profiles, dev+packaged contention,
monitor loss, permit expiry and control with all macOS F5 windows closed. Benchmark Windows
include-only composition on 50 windows (target <150 ms release build).

Built-ins additionally require recorded enablement, user consent, F5 pre-call veto, stop
behavior, targetability of F5/blocked apps, screenshot scaling (Claude), and Codex plugin
reads/writes under its configured `CODEX_HOME`. No provider credential/state from another
F5 profile may be accessed. Publish the weaker guarantees in the table above alongside
actual measurements. Chrome certification must record all registration changes,
concurrency behavior, successful calls, live policy/pause denial and byte-for-byte restore.

Repository gates: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test:full` and
`bun run test:desktop-smoke`. Never use `bun test`. Native checks are `swift test`,
`cargo test`, generated-tier drift and helper hello/permissions protocol checks. Live
provider tests are opt-in and consume account quota; they do not replace signed-machine
certification. Existing preview broker regression tests remain unchanged.

`integration/computerMcp.test.ts` exercises the authenticated HTTP catalog against a
controlled IPC host: catalog discovery, app consent, a model-readable image block, action
authorization, session-action approval, pause rejection and credential cleanup. The opt-in
`claudeComputerMcp.live.test.ts` and `codexComputerMcp.live.test.ts` add real provider tool
discovery and image/action transport. Their host simulates an app and does **not** inject
OS input; signed-machine actions and the isolation/latency checks still need the manual
matrix above. Codex records additional approval methods and rejects unexpected requests.

## Review follow-up and remaining release work

Native policy tests now exercise both tier tables, blocked chords, interrupted input,
held-input release, device-lock contention, window recipient exclusions and independent
hook failure. They do not replace real OS recipient/capture tests, the complete planned
native authorization matrix, Windows execution or signed-machine certification.
Native tests now call the same focus, owner, secure-element, chord and menu-region
policies as the helpers. Windows composition tests exercise the actual pixel cropping
and alpha composition used by capture, including invisible borders and negative origins.
Claude Chrome launch/consent/lease/veto/restore consumers are connected behind empty
certification records. Provider built-in launch bridges and Codex Chrome plugin wiring
remain unavailable for the integration constraints above. No native, built-in or Chrome
release gate was enabled by this work.

Transport admission joins concurrent retries by MCP request identity and retains completed
IDs as tombstones. A late retry gets `ReplayRejected` rather than repeating input.
Post-action captures can return `screenshotError` alongside `actionCompleted: true`; a
failed capture does not turn a delivered action into an input failure. Positive vertical
scroll deltas mean down, and positive horizontal deltas mean right. Ambiguous app queries
return candidate identities instead of adding every match to a default-selected card.

The Codex process-liveness guards are required to keep retired process events from
changing a replacement session and its computer authority. The Claude rejected-resume
fix is broader than computer use: the existing “reports the first turn after a rejected
resume point as not sent” regression requires `deliveryRetryable: false`, so a rejected
resume cannot trigger an automatic resend. It remains included as an explicitly identified
prerequisite bug fix and is covered by that adapter test, including sessions with computer
use disabled.

To collect a preflight without granting access or injecting input, run:

```sh
bun scripts/record-computer-certification.ts --app /Applications/F5.app --output /tmp/f5-certification.json --build-commit <installed-build-commit>
```

For a development binary use `--helper <path>` instead of `--app`. The recorder hashes
and verifies signatures, starts the helper suspended and observes permissions only.
It refuses to overwrite a report and leaves every machine-test item pending with
`certified: false`. It records repository and installed-build commits separately; a
preflight never proves TCC identity, real capture isolation or input-stop latency.

The unsigned macOS rehearsal controls two temporary AppKit test apps containing only
synthetic data. It grants no existing user app, starts a fresh permit, stops on physical
input without resuming automatically, and closes its own app/helper at exit:

```sh
bun apps/desktop/src/computer/rehearseHelperMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-native-rehearsal.json
```

It exercises real app activation, accessibility inspection, semantic pressing, secure
field refusal, grant revocation, display-space clicking, Unicode typing, protected chords
and permit expiry. It verifies that a second helper with a different `HOME` shares the
OS user's device lock. Capture checks first show both synthetic color markers when
both apps are granted, then revoke the second app and verify its marker disappears.
They also check secure-field masking in JPEG captures and PNG zoom, and additional
Retina zoom detail. Images are decoded and checked in memory by the fixture verifier.
The report keeps outcome codes and timings; no typed values,
accessibility content or screenshots are saved. A protected pointer refusal remains a
failed check; only the independent permit-expiry refusal check continues afterward. Physical input ends the rehearsal without resuming.
Failed or skipped checks are not certification evidence.
Signing is deferred for this development work. Capture masking across the real-app
matrix, physical kill-chord latency, provider turns through the full Electron desktop,
renderer/backend failures, multiple profiles, overlays,
Windows runtime and installed-build TCC attribution still need recorded machine tests.

A separate opt-in rehearsal connects real Claude/Codex turns to the production
`ComputerHostChannel`, `ComputerController`, lease authority, helper client and native
helper through inherited process IPC. It creates a fresh synthetic AppKit app for each
provider and independently observes one button press and the expected Unicode typing
inside that app. No existing user app receives a grant. Scripted consent permits only
the exact fixture identity, rejects mixed-app requests and never remembers a grant.
It exercises the broker's session-actions approval separately from app access.

```sh
F5_COMPUTER_PROVIDER_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProviderMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --provider both --output /tmp/f5-provider-native-rehearsal.json
```

Select the profile's Claude credential directory with `CLAUDE_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, both pointing to that profile's `.claude` directory.
For Codex set `CODEX_BINARY_PATH` and `F5_CODEX_CERTIFICATION_HOME` (or `CODEX_HOME`).
The worker preserves the real macOS login home/name for Claude's keychain lookup.
Codex uses a temporary home containing only a private copy of that selected account's
credential, disables plugins and denies command/filesystem approval requests. The
worker accepts an additional MCP consent once only when it names the exact
authenticated F5 computer catalog created by that worker and its form is representable;
commands, unknown servers, URL prompts and unrepresented fields are denied. The
temporary home is removed on success, failure or interruption. The test consumes
provider quota and foreground input; leave the mouse and keyboard idle. Physical input
stops the worker and input authority; a fresh run needs explicit user coordination.
Reports refuse overwrite, retain only operation names, booleans, timing and build
metadata, and never include images, accessibility content, typed values or provider
error details. Capture, nonempty accessible inspection of the fixture, and input must
have valid successful native responses correlated to their request IDs; dispatch and
normal turn completion alone cannot pass. Failed, interrupted and incomplete turns
cannot pass. Earlier provider evidence without these response checks proves dispatch
and independently observed app delivery only; capture/inspection response validation
requires a new coordinated run of the strengthened harness.

This harness deliberately omits Electron renderer windows and real overlays. Its
scripted fixture consent does not certify the trusted consent dialog. Provider calls
through this harness do not prove installed-build attribution, physical kill-chord
latency, the real-app workflow/capture matrix, multiple profiles/displays or Windows
desktop behavior, and never open a release gate.

The first real run exposed a macOS transport defect: `FileHandle.read(upToCount:)` waited
for a full pipe buffer, preventing short requests and suspend messages from executing.
The helper now uses an interruptible POSIX read; XCTest verifies a short command arrives
while stdin remains open. The build protocol check requires a correlated suspend
acknowledgement rather than accepting an unsolicited status heartbeat.
For an elevated Windows CI process, a helper may refuse startup and exit cleanly with
`missing-permissions`. The protocol probe accepts only that explicit fail-closed startup
case; it does not claim an interactive round trip or input health. A running helper must
still answer the correlated permissions and suspend requests. Broken-pipe writes, bad
versions, incomplete handshakes and abnormal exits cannot become a successful usable
helper check.

The [2026-10-10 unsigned evidence](../computer-certification/2026-10-10-macos-unsigned.json)
records six passed real-app checks after the pipe fix, protected-system-UI refusals during
pointer checks, and a physical-input interruption in a separate run. It also records the
installed plugin versions/hashes and unsupported launch reasons. These results establish
only the listed development observations; the rest of the release matrix remains pending.

The [2026-10-11 idle-Mac evidence](../computer-certification/2026-10-11-macos-unsigned.json)
records nine passed checks, now including real Unicode typing, protected-system-chord
refusal and typing refusal in a focused secure field. Coordinate input remains failed:
a Dock-owned layer-20 window spans the display and is the top rectangular candidate at
the synthetic button. The helper retains its protected-system-UI refusal. The independent
permit-expiry check passed afterward without retrying the pointer action or resuming
input. That historical run exits with failure; the pointer failure is addressed by the
later evidence below.

The [2026-10-11 pointer and capture evidence](../computer-certification/2026-10-11-macos-pointer-and-capture.json)
records 14 passed native checks after replacing rectangle-based pointer authorization
with [AppKit's actual mouse-down recipient query](<https://developer.apple.com/documentation/appkit/nswindow/windownumber(at:belowwindowwithwindownumber:)>).
The helper initializes AppKit without activation or windows, converts Quartz coordinates
to AppKit global points, and resolves the selected window's owner. Unknown, stale or
unexpected overlay recipients remain blocked. This avoids treating a transparent Dock
rectangle as the click recipient. The device lock now uses the OS account's home,
preventing isolated provider `HOME` values from creating separate locks.

The same evidence records successful live Claude and Codex F5-tool transport tests:
discovery, fixture consent, model-facing image results and an action dispatch. These
tests use a simulated desktop host and emit no OS input. Codex CLI 0.162.1 reported no
additional MCP approval in this full-access run. The Claude test preserves the macOS
login name and real home for keychain lookup while retaining the profile's config dir;
the initial isolated test's authentication failure did not mean the running F5 session
was signed out. Native checks use real OS input in synthetic apps, separately from
these model-backed transport tests. Neither proves the full provider-to-desktop path,
physical stop latency, signed attribution or the Windows/multiple-display matrix.
All release gates remain closed.

The [2026-10-12 real-provider/native evidence](../computer-certification/2026-10-12-macos-real-provider-native.json)
records successful Claude and Codex turns through the production private host channel,
broker, controller, lease authority and native helper. Each provider received access to
one temporary AppKit fixture, took a native screenshot, inspected its real accessibility
tree, pressed its button once and typed the expected Unicode text. The fixture itself
reported receipt independently of the model's response. Both workers released their
turn lease before exit. Claude's model-facing native image block was directly observed.
Codex CLI 0.162.1, in approval-required mode, issued five additional MCP approval prompts;
each was accepted once for the exact test catalog. An earlier denied-prompt run delivered
no input. A separate physical-input attempt interrupted the worker without auto-resume.
All 14 native-helper checks passed again after sharing the fixture launcher.

These observations replace the earlier simulated-host limitation for this narrow
provider-to-native-controller path. The harness uses scripted fixture consent and no
Electron renderer or real overlay windows; it does not certify the complete desktop
experience, physical kill-chord latency, real-app/multi-display/multi-profile matrix,
Windows desktop behavior or installed-build permission attribution. Signing remains
deferred, and every release gate stays closed.

The [2026-10-12 correlated-response evidence](../computer-certification/2026-10-12-macos-provider-correlated-results.json)
records a fresh passing run for both providers after strengthening the rehearsal's
result checks. Both received valid successful native capture responses, nonempty
accessible inspection of their exact fixture, and successful input responses matched
by request ID. Each fixture independently observed exactly one press and the expected
Unicode text, and both workers released their leases. Claude's model-facing image was
observed again; Codex issued five catalog-specific approvals, all accepted once.
This replaces the historical dispatch-only limitation for these narrow response checks.
Scripted consent, the absence of real Electron UI/overlays and the other release
certification limitations still apply; no release gate is opened.

The human-assisted physical-stop rehearsal observes only event timings inside a
temporary synthetic AppKit window. The helper reports its monotonic recognition time
before releasing held input; the fixture records native event-creation and app-delivery
times without reading characters or logging physical key codes. A passing run requires
active synthetic typing, both physical input and the complete kill chord, a quiet tail,
interrupted input, refusal of further typing and a released lease. Missing traces,
clock mismatches, overflow and timing uncertainty fail the check.

```sh
F5_COMPUTER_STOP_REHEARSAL=1 bun apps/desktop/src/computer/rehearseStopMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-physical-stop.json
F5_COMPUTER_STOP_REHEARSAL=1 bun apps/desktop/src/computer/rehearseStopMacos.ts --helper apps/desktop/dist-native/mac-universal/f5-computer-helper --output /tmp/f5-frozen-backend-stop.json --freeze-backend
```

Coordinate an idle window with the operator first. Press Control+Command+Escape only
when the fixture turns red and says NOW. Physical input latches pause; the harness never
resumes input. The frozen-backend mode uses the real broker/host IPC classes, grants only
its own fixture, SIGSTOPs that worker during typing, verifies its stopped OS process
state before and after the chord, then SIGCONTs it only for cleanup. It uses no provider
account/quota. A separate `--stall-host` mode blocks the test supervisor for 700 ms.
In this mode the countdown holds before red; the supervisor first waits for a fresh
heartbeat, flushes the red-cue command, and immediately blocks. This avoids prompting
the operator while a heartbeat wait still delays the stall. Clock offset bounds come
from a native-fixture round trip; both recognition events must
fall conservatively inside that interval, otherwise the stalled-host check fails.
Execution permits retain the production one-second expiry and 250 ms renewal cadence.
No renderer or real overlay is launched in either mode.

The [2026-10-12 physical-stop evidence](../computer-certification/2026-10-12-macos-physical-stop.json)
records a passed responsive-host run (0 ms input-emission tail, 0.4 ms delivery tail)
and a passed frozen-broker-backend run (no recorded synthetic event created or delivered
after recognition). A zero tail means the last synthetic event preceded recognition;
it is not an exact zero-time cancellation measurement. Both runs observed the full chord,
interrupted the action, refused further typing and released the lease. The operator
reported no system action during the first two attempts. The three supervisor-stall
attempts stayed below 100 ms for stopping input but **failed** timing/arming coverage,
so they do not certify a stalled supervisor. The revised heartbeat-before-red sequence
was retried with a 6.9 ms delivery tail but still failed interval coverage; this is
recorded in the [cue-fix attempt](../computer-certification/2026-10-12-macos-stalled-cue-attempt.json).
Later reports include conservative relative recognition offsets from the stall start/end
to distinguish early, late and clock-uncertain triggers. No absolute uptime or raw input
trace is saved, and the historical failures remain unchanged.
Signed installed-build attribution, real
Electron renderer/backend failures, Windows and the full release matrix remain pending.
No gate is opened by this unsigned evidence.

### Real Electron rehearsal

The opt-in Electron rehearsal launches the compiled F5 main, preload, renderer and
server with isolated application state. It copies only the selected Codex profile's
authentication file into its temporary private home, disables plugins, creates its own
temporary project, and grants no user app automatically. Build the desktop first:

```sh
bun run build:desktop
F5_COMPUTER_ELECTRON_REHEARSAL=1 bun apps/desktop/scripts/rehearse-computer-electron.mjs --codex-home <selected-profile-home> --codex-binary <codex-binary> --output /tmp/f5-electron-computer.json
```

The same runner supports `--provider claude --claude-home <selected-profile-home>
--claude-binary <native-sdk-cli>`, with optional `--model`. It retains temporary F5
and Claude config/transcript state and copies only the selected credential file if one
exists. Standalone probes use a `.js` launcher. The Electron run keeps F5's default
bundled SDK executable and compatibility checks; a test-only backend bootstrap supplies
the selected secure-storage namespace only to absolute Claude executable spawns whose
config directory is inside the temporary installation. It preserves the executable,
arguments and real macOS login home/name; it never copies settings,
plugins, transcripts or keychain contents. A read-only authentication preflight runs
before Electron, consent or desktop actions. Missing/unknown authentication fails
closed rather than falling back to another account. The full-access runtime and
production consent/tool/stop paths remain unchanged.

Authentication preparation can run separately without a provider turn or desktop
input, even while the operator uses the computer:

```sh
bun apps/desktop/src/computer/rehearseClaudeAuthMacos.ts --claude-home <selected-profile-home> --claude-binary <native-sdk-cli> --output /tmp/f5-claude-account-preflight.json
bun apps/server/scripts/rehearse-claude-sdk-launch.ts --claude-home <selected-profile-home> --claude-binary <native-sdk-cli> --output /tmp/f5-claude-sdk-launch.json
```

This probes only a fresh process with the selected credential scope. An unavailable
test login does not establish that an existing F5 Claude session is signed out. No
account identifiers, credential values or raw CLI errors are retained in its report.
The SDK launch preflight additionally initializes the actual SDK/CLI bridge and
checks model metadata with an empty input stream and all tool execution denied.
It sends no user prompt, starts no model turn and does not control the desktop.

The [Claude account preflight](../computer-certification/2026-10-12-macos-claude-account-preflight-ready.json)
on clean revision `dc7487b8a2` authenticated through the selected profile's secure
storage without copying a credential file. The [first Claude Electron attempt](../computer-certification/2026-10-12-macos-claude-electron-real-apps-startup-attempt.json)
then failed before requesting consent, with zero native operations, no lease and
no test document opened. It remains failed. A read-only SDK probe identified a
launcher mismatch: this SDK recognizes `.js` scripts but treats `.cjs` as native
executables regardless of the supplied Node executable option. The rehearsal
wrapper now uses `.js`; a regression checks its prepared suffix and private,
credential-only copy. Account readiness alone does not prove SDK launch readiness.

The [corrected SDK launch preflight](../computer-certification/2026-10-13-macos-claude-sdk-launch-passed.json)
passed on clean revision `6826b08a0d`: selected-profile authentication, SDK
initialization and selected model metadata, with zero model turns or desktop input.
The [next Electron attempt](../computer-certification/2026-10-13-macos-claude-electron-pre-consent-attempt.json)
on that same revision still failed in its first F5 provider turn before requesting
consent. No native operation, lease or document setup occurred. Its report remains
failed; SDK launch readiness does not prove the complete F5 session-start path.
The runner now fails promptly on a pre-consent turn error and keeps a fixed diagnostic
category derived from the session error, never its contents. Its read-only status
mode uses plan interaction mode, which independently refuses native mutations.

A [subsequent read-only diagnostic](../computer-certification/2026-10-13-macos-claude-readonly-dirty-passed.json) passed three F5 Claude composer turns with correlated
app-metadata responses, no consent request and no computer lease or input. It used
the bundled SDK and the scoped test bootstrap described above. That diagnostic ran
with uncommitted rehearsal changes and is not machine certification or proof of
production profile isolation. The earlier failures remain failed; the successful
read-only run does not establish their exact causes. The [earlier dirty read-only failure](../computer-certification/2026-10-13-macos-claude-readonly-dirty-failed.json) also remains failed.
The [clean-revision read-only run](../computer-certification/2026-10-13-macos-claude-readonly-clean-passed.json)
on `02f40fb83b` then passed the same seven checks. The [Claude real-app attempt](../computer-certification/2026-10-13-macos-claude-real-apps-baseline-attempt.json)
on that revision passed trusted app consent, capture, inspection, exact saved Unicode
document bytes, document closure and Calculator launch. It stopped before arithmetic
because its distinguishable-baseline check failed. That report does not distinguish
an inaccessible baseline from an already-visible result and remains failed; no cause
is claimed. The fixture now requests an offered semantic Clear/All Clear press and
requires an independently visible zero with 42 absent before the calculation turn.
It records only fixed accessibility/result booleans for that baseline. This strengthens
the baseline, keeps failed actions nonretryable and adds no production authorization.

The [Claude real-app retry](../computer-certification/2026-10-13-macos-claude-electron-real-apps-passed.json)
on clean `80c4be85cc` passed all 16 checks with the unchanged updated helper hash
`a11ef2e783c9d344372f9b12a86e0a1a67ec40ddecaafc1e0f5a27cfcd8d7c9e`.
Human consent approved only TextEdit and Calculator. Saved Unicode file bytes matched
exactly and the owned document closed. Calculator's zero baseline and final 42 were
verified independently, with eight correlated semantic presses including baseline
clear. Four composer turns, three captures, six inspections, surviving grants, visible
loaded activity imagery and lease cleanup were observed, with no tagged errors or
unexpected app input. This is one unsigned macOS two-app Claude checkpoint, using the
explicitly selected account through the temporary rehearsal bootstrap. It does not
prove production credential isolation, the full provider/app/protection matrix,
multi-profile/display privacy, Windows desktop execution or signed installed-build
attribution. Earlier failures remain unchanged and no release gate is opened.

The `--real-apps` mode checks TextEdit and Calculator through the compiled Electron
app and the selected provider session. Both apps must initially be closed; a read-only verifier
checks this before Electron launch and again after consent. The first composer turn
requests exactly these two app IDs and executes no input. After real human consent,
setup opens its own temporary UTF-8 text file in TextEdit. A read-only AX verifier must
confirm that this file is the focused document before the provider's editing turn.
Provider F5 tools perform inspection, Unicode typing and saving; the coordinator checks
the saved file bytes directly. A subsequent turn closes only that saved test document
and launches Calculator, then clears it through an offered semantic button. The test
requires an independently verified zero baseline with 42 absent before semantic
button presses calculate 12 + 30; an independent AX check verifies 42. Four composer
turns, correlated per-app native outcomes, captures, surviving grants and lease cleanup
are required. The verifier emits only booleans, bounded counts and fixed state codes.
Unconfirmed document closure retains the test file and reports its location; private
provider/application state is always removed. Apps are not forcibly quit. Grants are
app-wide, so this workflow does not establish capture privacy or the complete real-app
matrix. Coordinate an idle window with the operator before starting.

The separate opt-in protection rehearsal exercises the native helper against Terminal
and real Chrome, without a provider turn or F5 consent shortcut. Terminal and Chrome
must both be closed before starting. It grants Terminal `click` with typing off and
requires exact `NotGranted(type)` responses to keyboard typing and semantic `setValue`.
It checks the foreground identity around keyboard refusal; it sends no command, Enter
or other chord. Chrome uses a new private profile with extensions disabled and only a
local synthetic password page. No signed-in browser profile is opened.
The temporary test process uses `--use-mock-keychain`, the macOS test flag in
[Google's Chrome launcher](https://github.com/GoogleChrome/chrome-launcher/blob/main/src/flags.ts),
so the fixture does not depend on or modify the real login keychain. This flag is
confined to the rehearsal; it is not a production setting or Chrome integration bridge.
Real keychain, autofill and password-manager behavior remain outside this checkpoint.

```sh
F5_COMPUTER_PROTECTION_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProtectedAppsMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-protected-apps.json
```

Chrome inspection must identify the focused secure field, omit its value and offer no
actions. Semantic `setValue` and keyboard typing must return `TargetBlocked(secure-field)`;
the page independently reports only whether its synthetic value changed and an input
event count. Captures require positive controls in both granted apps, then exclusion of
the revoked app while retaining the Chrome marker and secure-field mask. Password zoom
must be masked; revoking Chrome must refuse inspection and remove its marker too.
The pixel verifier scopes color searches to known AX marker rectangles so unrelated
Chrome icons cannot stand in for a fixture. Existing unscoped modes are unchanged.
Swift synthetic bitmap tests check positive controls, region scoping, an exposed secure
area and invalid bounds without reading a screen.

Any physical input or unexpected outcome aborts without automatic resume or retry.
Cleanup requests normal termination only for identified test-created app processes;
after physical input it leaves those apps alone. If Chrome cannot be confirmed closed,
the private profile is retained and its location printed locally. No image bytes,
typed text, raw errors, AX names/values or account details are saved in the report.
This is unsigned native-helper coverage on fixed windows and one display, with scripted
grants/permit. It does not prove provider consent, overlays, signed-in-site privacy,
popups, moving-window/profile/display isolation, installed-build attribution or the
complete protected-target matrix. Release gates remain closed.

The [first Terminal/Chrome protection attempt](../computer-certification/2026-10-13-macos-terminal-chrome-protection-interrupted.json)
on clean `528b75ac0e` passed the closed-app prerequisite, Terminal opening/inspection,
and exact typing/semantic-value refusals with typing disabled. The helper then
detected physical input during isolated Chrome setup and stopped before Chrome
inspection or pixel checks. The operator confirmed mouse/keyboard use. The attempt
remains failed/incomplete and proves no Chrome masking or exclusion result. Apps
were retained, including the temporary private browser profile, without forced
termination. A retained browser is now detached from the completed rehearsal CLI
so it does not keep that CLI running; it is neither killed nor resumed.

The [idle Terminal/Chrome retry](../computer-certification/2026-10-13-macos-terminal-chrome-protection-startup-attempt.json)
on clean `03f52ac0e2` again passed all four Terminal/prerequisite checks, then failed
before Chrome inspection or capture, with no physical interruption. The operator
reported a missing-keychain prompt in the test-created Chrome. The attempt remains
failed and does not prove Chrome protection. No real keychain was created or changed.
Headless diagnostics without the mock flag did not reach the page; adding the
installed browser's supported mock-keychain flag reached the fixture with valid
readiness in both the inherited and OS-login environment experiments. Those temporary
experiments are setup observations, not release or desktop protection proof.

The [checked-in headless setup diagnostic](../computer-certification/2026-10-13-macos-chrome-headless-startup-dirty-passed.json)
then passed all six startup checks with uncommitted rehearsal changes. Headless and
desktop checks now share the same loopback fixture and private-profile/mock-keychain
arguments. Fixed startup booleans distinguish page delivery, valid/rejected observations,
process identity and launcher exit; no raw error, process argument or page value is saved.
The shared fixture has no execute path and rejects unrelated routes and invalid/oversized
observations. This preflight can run while the operator works:

```sh
bun apps/desktop/src/computer/rehearseBrowserProtectionStartupMacos.ts --output /tmp/f5-chrome-protection-startup.json
```

It exercises no helper, grants, AX, capture or OS input. A clean-revision desktop run
is still required for Chrome password refusal and pixel masking/exclusion evidence.

The [clean headless preflight](../computer-certification/2026-10-13-macos-chrome-headless-startup-clean-passed.json)
on `8453b5d0d4` passed all six startup checks. The [corrected desktop protection attempt](../computer-certification/2026-10-13-macos-terminal-chrome-protection-empty-capture-attempt.json)
on the same revision passed 11 checks: Terminal typing/value refusal, Chrome secure
inspection/value omission, exact semantic and keyboard secure-field refusals, unchanged
synthetic DOM value with zero input events, positive capture controls, JPEG masking,
revoked-app omission/refused inspection and masked PNG zoom. It remains failed because
the final capture with every grant revoked returned `Unavailable`. No physical input
was observed and both test apps closed normally. The operator had connected an external
monitor; the report records both displays, with the external monitor primary. These
app/field checks target one display, not the full multi-display isolation matrix.

A suspended, empty-grant probe reproduced `missing-permissions` for both capture and
zoom while the helper still reported available. The helper had sent an empty application
include list to ScreenCaptureKit's image capture. The empty case now generates the
neutral canvas without invoking image capture. Permission preflight, shareable-content
resolution, grant/version and geometry revalidation, encoding and zoom limits remain
enforced. Nonempty capture failures still propagate; they never return a neutral fallback.
Native callback/canvas tests exercise zero-app avoidance, authorized composition,
invalid dimensions/counts and failed-capture propagation.

The [development empty-capture diagnostic](../computer-certification/2026-10-13-macos-empty-capture-dirty-passed.json)
then passed JPEG and PNG neutral-frame verification on both connected displays, without
grants, permit, resume, app launch or OS input. The helper stayed suspended across 24
heartbeats. Every decoded pixel is checked against the neutral reference, including
frame edges. That run used uncommitted changes and updated helper
`1ad51ad9e98fed5820461304019f55708a7f6667908fccb5c6db199ade79c176`;
it proves neither granted-app privacy on both displays nor a complete protection gate.
Earlier stop/real-app evidence remains pinned to its original helper hashes; it is not
new binary certification. The read-only diagnostic can run while the operator works:

```sh
bun apps/desktop/src/computer/rehearseEmptyCaptureMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-empty-capture.json
```

The [clean empty-capture diagnostic](../computer-certification/2026-10-13-macos-empty-capture-clean-passed.json)
on `5b60b4bebf` also passed all four neutral JPEG/PNG checks across the two connected
displays, with the helper suspended. This confirms the empty-grant fix on that revision.

The [subsequent idle protection run](../computer-certification/2026-10-13-macos-terminal-chrome-protection-capture-unavailable-attempt.json)
on the same clean revision and helper passed the first seven checks, including exact
Terminal typing/value denials and Chrome secure-field inspection, semantic/keyboard
denials and unchanged synthetic DOM value with zero input events. The first nonempty
capture returned `Unavailable` before pixel verification; the run stopped without
retrying and both apps closed normally. No physical interruption was recorded. This
report contains only the error tag, so it does not establish which capture API failed
or why. The preceding 11-check attempt remains separate evidence; its success is not
attributed to this later binary. Future failed checks retain the unavailable reason,
missing-permission enums and helper availability, while dropping raw messages and
status detail. These diagnostics do not silently retry or weaken capture protections.

Release gates remain closed. The complete protection workflow still needs a passing
run after the nonempty capture failure is diagnosed; signing remains deferred.

The [background diagnostic before the fix](../computer-certification/2026-10-13-macos-background-capture-crashed-dirty.json)
reproduced a helper crash without any input or active lease. The [content-free crash diagnosis](../computer-certification/2026-10-13-macos-capture-crash-diagnosis.json)
records selected native symbols from that crash and the preceding protection run:
`CFRetain`, `CGColorCreateCopy`, and `SCStreamConfiguration.copyWithZone:` during
`SCScreenshotManager` setup. The installed SDK declares `backgroundColor` as an
`assign` (non-retaining) `CGColorRef`; assigning a temporary color left its lifetime
unprotected. The helper now retains the color through completion of the asynchronous
capture, including failure. Native tests suspend and then copy the actual configuration,
and verify that capture errors propagate.

The [next background probe](../computer-certification/2026-10-13-macos-background-capture-empty-display-dirty.json)
captured the authorized synthetic marker on the external display but returned SCK
error `-3811` on the laptop display, which had no granted window. Fresh on-screen
shareable-content metadata now establishes which authorized apps have windows
intersecting each display. If none do, the helper generates the neutral canvas before
calling image capture. Errors when eligible windows exist still fail closed; no error
causes a blank fallback or retry. Boundary tests cover empty rectangles, adjoining
display edges, partial overlap and negative display origins.

Capture failures additionally retain only an API-stage enum, a normalized error-domain
enum and numeric code. Native and transport tests confirm that localized descriptions,
arbitrary domains, userInfo and extra native message fields are not retained. A separate
read-only background probe uses one temporary synthetic app and a suspended
helper. It captures each connected display and requires a positive marker in at least
one, without granting, activating or inspecting existing apps, renewing a permit, or
injecting input. Images remain in memory. It can run while the operator works:

```sh
bun apps/desktop/src/computer/rehearseGrantedCaptureMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-background-capture.json
```

This probe does not certify Chrome password masking, F5 consent, providers, overlays,
complete display isolation, stop latency, or signed installed-build attribution. The
full protection rehearsal remains a separate checkpoint; all release gates stay closed.

The [fixed background development run](../computer-certification/2026-10-13-macos-background-capture-fixed-dirty-passed.json)
passed captures on both connected displays, with the synthetic marker present on the
external display and the helper suspended throughout. It used uncommitted fixes and
helper `42e5f28a123a74b947ce93d0962494c497ab5f889fb68f6576c3ceb3793e48c5`;
the report's actual binary hash is authoritative. It is narrow capture evidence only.

The [clean background capture run](../computer-certification/2026-10-13-macos-background-capture-clean-passed.json)
at `e205dbe2b4` passed both displays with the same helper, a positive synthetic marker
on the external display, and every decoded pixel neutral on the laptop display. The
helper remained suspended. Formatting, lint, typecheck, all 36 Swift tests, 17 targeted
helper/diagnostic tests and the universal build/protocol check passed. The initial full
suite hit a WebSocket setup connection failure; all 119 WebSocket cases then passed in
isolation, followed by a clean-environment full-suite pass including all 136 exhaustive
Git tests. No WebSocket implementation or test was changed. The full Terminal/Chrome
protection checkpoint and broader release certification remain pending.

The [first full run with the fixed helper](../computer-certification/2026-10-13-macos-terminal-chrome-protection-capture-setup-attempt.json)
at clean `88722a415a` passed all seven input-protection checks and recorded no physical
interruption, unchanged synthetic DOM value and zero input events. It stopped during
capture-target setup, before requesting a screenshot. The report's `failureStage`
incorrectly retained the preceding passed check's name; no geometry diagnostics were
recorded, so the precise missing/mismatched target cannot be identified from that run.
Both apps closed normally. This remains a failed/incomplete attempt.

The harness now records capture setup separately, retains only bounds-presence booleans
and display IDs, and counts a separate same-display geometry check. The green fixture
is created in the background on Chrome's inspected display, using an explicit native
display ID rather than default window placement. Unknown IDs fail instead of selecting
another display. The background probe accepts optional `--display-id <id>` to verify
this fixture placement without input or app activation. No helper authorization,
capture policy, stop path or release gate is changed by this harness correction.

The background development checks then verified explicit placement and AX marker
bounds independently on the [external display](../computer-certification/2026-10-13-macos-background-capture-external-geometry-dirty-passed.json)
and [laptop display](../computer-certification/2026-10-13-macos-background-capture-laptop-geometry-dirty-passed.json).
Each run saw a positive marker on the requested display and verified every decoded pixel
neutral on the other display. The helper stayed suspended. For inspection, this probe
uses the synthetic app's actual catalog tier (`full`); it never provides an execution
permit or resumes input. Earlier capture-only probes used a `view` grant and did not
test AX inspection. These development checks do not prove the cause of the earlier
setup failure or the complete Terminal/Chrome protection workflow.

The [clean explicit-display background check](../computer-certification/2026-10-13-macos-background-capture-external-geometry-clean-passed.json)
at `1c964b078d` verified the marker's AX bounds and positive pixels on the requested
external display, and every decoded pixel neutral on the laptop display, with the helper
suspended. The [full corrected protection rehearsal](../computer-certification/2026-10-13-macos-terminal-chrome-protection-passed.json)
on that same clean revision passed all 13 checks with helper
`42e5f28a123a74b947ce93d0962494c497ab5f889fb68f6576c3ceb3793e48c5`.
Terminal keyboard and semantic typing were refused without typing rights. Chrome
secure-field values were omitted from inspection, semantic/keyboard input was refused,
the synthetic DOM value remained unchanged with zero input events, and JPEG captures
and PNG zoom masked the password field. Positive capture markers passed; revocation
refused inspection and excluded the fixture/browser markers, including after all grants
were removed. No physical interruption occurred and both apps closed normally.

This completes the narrow unsigned Terminal/isolated-Chrome protection checkpoint.
It uses scripted helper grants/permits and fixed app windows on one target display in a
two-display environment. It does not certify F5 renderer consent, provider transport,
overlay isolation, moving windows, real keychains/autofill or signed-in browser sites,
the complete system-surface/profile/display matrix, Windows runtime, or signed
installed-build attribution. Prior failed reports remain failed. Older stop/provider
measurements stay pinned to their original helper hashes and do not certify this binary.
All native, built-in and Chrome integration release gates remain closed; signing stays
deferred. Formatting, lint, typecheck and the full suite (136 exhaustive Git tests) passed
before this clean run; the subsequent evidence change is documentation only.

The helper rehearsal's `--privacy-only` mode runs the existing pixel-verification
checks without its semantic/keyboard/pointer actions. It uses only two temporary
synthetic apps with scripted helper-level grants: a positive control includes both
colored markers, revocation excludes one marker, secure fields are omitted from AX
values and masked in JPEG captures and PNG zoom, and Retina zoom must add detail.
Device-lock contention and permit-expiry refusal remain checked. Images stay in memory;
reports keep outcomes and repository/helper/verifier source hashes. The temporary
fixtures are terminated and their files removed. This is native-helper coverage, with
no real provider consent, Electron overlays or cross-profile activity proof.

The first [capture-only attempt](../computer-certification/2026-10-12-macos-capture-privacy-interrupted.json)
passed device-lock contention, fixture activation and secure-value omission, then
auto-paused before its first capture. The operator confirmed mouse/keyboard input.
The attempt remains failed/incomplete, with `physicalInterruption: true`; it proves
neither pixel exclusion nor masking. The real-app phase was held rather than resumed
automatically. Capture-only fixture windows require no clicks or keyboard interaction.

The subsequent [capture-only run](../computer-certification/2026-10-12-macos-capture-privacy-passed.json)
passed all seven checks on clean revision `03695fecc2`, with no physical interruption.
The positive control included both fixture markers; revocation excluded the ungranted
marker while retaining granted content. Secure fields were masked in JPEG and PNG,
and Retina zoom provided additional detail. The device lock and permit-expiry refusal
also passed. This is unsigned synthetic-app helper evidence, not real-app/browser,
Electron overlay, cross-profile, mixed-display or installed-build certification.

The first [real-app run](../computer-certification/2026-10-12-macos-electron-real-apps-attempt.json)
on the same clean revision passed native human consent for TextEdit and Calculator,
owned-document verification, capture and inspection. The helper returned successful
typing and two key actions, with no interruption or tagged provider/tool errors, but
the saved test file did not match the expected text. A separate read-only AX check
confirmed the original seed remained in the test document; the disk also retained
the seed. The run remains failed and did not reach document closure or Calculator.
Its test file was retained rather than deleted while open. No cause is established:
successful injection alone does not prove application delivery. Future traces retain
only booleans for the fixed expected text and exact single select-all/save chords,
alongside correlated native outcomes; they retain no raw typed text or chords.

The [diagnostic retry](../computer-certification/2026-10-12-macos-electron-real-apps-diagnostic-attempt.json)
on clean revision `45c5aef2f5` confirmed the exact expected text and single Command+A
and Command+S requests, with successful native outcomes. The saved file still contained
the original seed, so this run also remains failed before Calculator. A read-only
post-run probe found Command set in combined session event state and inherited by a
new keyboard event. The helper had applied chord modifiers to both key-down and
key-up, and plain Unicode events used inherited state. Keyboard construction now
uses private state, explicit plain-text flags and modifier-free key-up/cancellation
events. Native tests exercise the real CGEvent flags, Unicode payload and marker
without posting OS input. The complete real-app workflow still requires a fresh run;
this fix does not change authorization, permit checks or certification gates.
Earlier passing physical-stop and capture reports remain pinned to their previous
helper hash; the later updated-helper checks below provide separate evidence.

The subsequent [real-app run](../computer-certification/2026-10-12-macos-electron-real-apps-passed.json)
passed all 16 checks on clean revision `bc51241ac6`, using rebuilt helper hash
`a11ef2e783c9d344372f9b12a86e0a1a67ec40ddecaafc1e0f5a27cfcd8d7c9e`.
Native human consent granted only TextEdit and Calculator. The exact Unicode test
text was typed and saved, with file bytes independently verified; the saved test
document was closed before its temporary files were deleted. Calculator was launched
and used through seven semantic button presses, with an independent AX check of 42
after a distinguishable baseline. The real Electron/Codex path completed four composer
turns, three captures, eleven inspections and 32 activity events with six thumbnails.
Both apps' grants survived the turns, the lease released, and no tagged tool/provider
errors or unexpected app input were observed. This passes the narrow unsigned Codex
TextEdit/Calculator workflow, not the complete provider/app/privacy matrix. Failed
attempts remain unchanged. Signing is deferred and all release gates remain closed.

All three updated-helper rechecks on clean revision `644fd2eecd` passed, with the
same `a11ef2e783c9d344372f9b12a86e0a1a67ec40ddecaafc1e0f5a27cfcd8d7c9e` helper
as the passing real-app run. The [capture-only check](../computer-certification/2026-10-12-macos-updated-helper-capture-privacy-passed.json)
passed all seven synthetic fixture checks without physical interruption. The
[frozen-main check](../computer-certification/2026-10-12-macos-updated-helper-electron-main-stop-passed.json)
verified a 703.7 ms Electron main freeze; the [frozen-renderer check](../computer-certification/2026-10-12-macos-updated-helper-electron-renderer-stop-passed.json)
verified a 406.5 ms renderer freeze. Both independently observed the physical chord,
recorded no synthesized input or app delivery after recognition, mirrored pause,
released the lease and refused subsequent typing. These are narrow unsigned macOS
Codex/synthetic-app checkpoints. Real-browser masking, complete consent integrity,
Claude real-app execution, multiple profiles/displays, Windows runtime and signed
installed-build attribution remain pending. No gate is opened by these results.

```sh
F5_COMPUTER_ELECTRON_REHEARSAL=1 bun apps/desktop/scripts/rehearse-computer-electron.mjs --codex-home <selected-profile-home> --codex-binary <codex-binary> --output /tmp/f5-electron-real-apps.json --real-apps
bun apps/desktop/src/computer/rehearseHelperMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-capture-privacy.json --privacy-only
```

The same runner accepts `--stop-renderer` or `--stop-main` for separate physical-stop
checks. Both use a timing-only synthetic fixture, the real human app-consent flow,
and a real provider typing call. An external supervisor SIGSTOPs the selected isolated
Electron process, verifies its OS process state, then sends the fixture's red cue.
The renderer mode remains frozen until the chord is observed (at most ten seconds);
the main mode measures a 700 ms freeze, with an independent 850 ms restoration limit.
SIGCONT is also guaranteed on runner cancellation and normal cleanup. The main mode
retains the production permit expiry, so a late human response fails coverage instead
of extending input authorization. Both physical recognition and the complete chord
must fall inside conservative clock bounds for the verified freeze. The checks also
require interrupted typing, a quiet delivery tail, mirrored pause, refusal of a new
typing call, and lease cleanup. No input, grant, permit or consent is injected by the
observation wrapper. Only counts, fixed outcomes and relative timing summaries are
saved; helper/fixture raw data and typed values are discarded. A SIGSTOP test covers
process unresponsiveness, not every possible deadlock. These runs do not open signed
release gates.

Electron stop modes opt into a separate passive session-event tap for the fixed physical
Control+Command+Escape chord, filtered to the fixture being frontmost. Electron's OS
shortcut registration may prevent AppKit from delivering the chord to the window,
especially while main is frozen. The independent fixture tap is listen-only: it cannot
inject, suppress or rewrite input; it reads no characters, retains no physical key codes,
and reports only chord-event and observation timestamps. Injected delivery and the first
physical event are still observed by the local AppKit monitor. Local chord receipts are
deduplicated when the passive tap is active. An unavailable or disabled tap fails the
check, without requesting permissions or falling back to helper-only evidence. A
`--probe-chord-monitor` fixture invocation checks availability without activating a
window or emitting input. The original native-controller modes keep their local-only
observer. Reports now count independent chord receipts and report their relative timing
delta, so a missing receipt can be distinguished from a clock mismatch.

The first [real frozen-renderer attempt](../computer-certification/2026-10-12-macos-electron-renderer-stop-attempt.json)
records both physical recognition and the full chord during a verified 709.4 ms renderer
freeze. Input emission stopped within 8.2 ms of physical recognition and app delivery
within 12.6 ms; typing was interrupted, pause mirrored and the lease released. The
**overall run failed** in its follow-up verification: the runner looked for the ordinary
Send message control instead of the Send now control shown after turn interruption.
It therefore did not prove refusal of a subsequent mutation or record a frontmost-app
receipt. The runner now handles Send now without resuming computer permission, and the
fixture reports its own frontmost state before subsequent composer interaction. The
original failed report remains unchanged; these fixes alone are not a passing rerun.

The first [real frozen-main attempt](../computer-certification/2026-10-12-macos-electron-main-stop-attempt.json)
completed the follow-up turn and proved refusal of another typing call, mirrored pause,
lease release and the fixture's frontmost receipt. Both helper recognition events fell
inside a verified 704.2 ms main-process freeze, with 0.4 ms clock uncertainty. No recorded
synthetic event was created or delivered after physical recognition. The **overall check
still failed** because the independent AppKit chord receipt did not match. That report
predates receipt counts and cannot distinguish a missing receipt from a timestamp
mismatch. It is preserved unchanged; the passive-observer change requires another
coordinated run and does not retroactively make this attempt pass.

The subsequent [real frozen-main run](../computer-certification/2026-10-12-macos-electron-main-stop-passed.json)
**passed every check**, using clean revision `b1a70f7362` and the recorded compiled
main, renderer, server and native-helper hashes. Real native app consent was answered
by the operator. Both recognition events occurred during a verified 708.4 ms Electron
main-process freeze, with 0.8 ms clock uncertainty; the independent fixture tap observed
one physical chord, whose event time differed from helper recognition by 0.1 ms. The
physical-input emission tail was 6.7 ms and the app-delivery tail 15.1 ms, below the
unchanged 100 ms boundary. Typing was interrupted, the lease released, the fixture
remained frontmost, and the subsequent provider typing attempt was refused while
computer access stayed paused. This proves the narrow unsigned macOS synthetic-app
stop path with real Electron main frozen. It does not certify installed-build TCC,
signed packaging, arbitrary deadlocks, real apps, Windows, mixed displays or built-in
provider backends. The earlier failed reports remain unchanged and all release gates
stay closed.

The subsequent [real frozen-renderer run](../computer-certification/2026-10-12-macos-electron-renderer-stop-passed.json)
also **passed every check**, using clean revision `ae526a1d02` and verified build/source
hashes. The isolated Electron renderer stayed OS-verified frozen for 407.5 ms, covering
both physical recognition and the independently observed full chord. Input emission
stopped within 5.9 ms of physical recognition and app delivery within 9.6 ms. After
restoration, the real provider's next typing call was refused without resuming computer
access; pause mirrored, the lease released and the fixture remained frontmost. This
completes the narrow unsigned macOS synthetic-app stop checkpoints for frozen main and
renderer. It retains the same installed-build, signing, real-app, Windows, mixed-display
and provider-backend limitations; it does not open release gates or replace the original
failed reports.

The [current-helper frozen-main attempt](../computer-certification/2026-10-13-macos-current-helper-electron-main-stop-no-chord-attempt.json)
at clean `a21530116b` used helper
`42e5f28a123a74b947ce93d0962494c497ab5f889fb68f6576c3ceb3793e48c5`, freshly
built Electron/server/renderer artifacts, and the two-display environment. Real human
consent settled and the isolated Electron main was OS-verified frozen for 703.4 ms.
Physical input was recognized 492.0–493.3 ms after the freeze began, with 1.2 ms clock
uncertainty. Both recorded emission and app-delivery tails after recognition were 0 ms.
The typing operation returned `Interrupted(user-input)`.

The overall attempt remains failed/incomplete: neither helper nor independent fixture
observer recorded the full chord. The runner stopped while waiting for chord recognition,
before the quiet-tail/frontmost receipt and subsequent paused-mutation refusal checks.
Those unperformed checks must not be interpreted as measured failures or passed cleanup
proof. No reason for the absent chord is established by this report. This is narrow
physical-input auto-pause evidence during a verified main freeze, not a current-binary
kill-chord certification. The earlier passing stop results remain pinned to their older
helper hashes. All release gates remain closed; signing stays deferred.

The operator reported pressing the full chord in that attempt. This human report is
kept separate from the missing machine receipts; no operator error is assumed.
A passive diagnostic isolates fixed-chord observation before another frozen-process
run. It launches only a temporary observer window, never a helper/provider, grant,
lease, execution permit, typing action or process freeze. At the red cue the operator
presses the chord once; the cue stays visible for approximately twelve seconds. The
observer retains only Escape's Control/Command booleans, a session/window source enum,
relative timings and a frontmost receipt. It never retains arbitrary key codes,
characters, raw packets or app content. Disabled monitoring, malformed traces and
unexpected marked injection fail the check. The additional candidate packets are
opt-in and ordinary stop rehearsals keep their existing protocol.

```sh
F5_CHORD_DIAGNOSTIC=1 bun apps/desktop/src/computer/rehearseChordMacos.ts --output /tmp/f5-passive-chord.json
```

Coordinate the physical press before launching. A successful passive diagnostic proves
only observation without active agent typing or a lease; it cannot certify kill-switch
latency, global-shortcut coexistence during a lease or frozen-process interruption.

The [clean passive diagnostic](../computer-certification/2026-10-13-macos-passive-chord-passed.json)
at `09b7cd98b4` passed: both the session tap and AppKit window observed Escape carrying
Control and Command, respectively 289 ms and 296 ms after the red cue. Monitoring and
the trace stayed valid, and the native finish receipt confirmed the fixture was still
frontmost. This confirms fixed-chord observation without active typing or a lease; it
does not establish the cause of the missing chord in the earlier frozen-main attempt.

The real Electron stop rehearsal accepts `--diagnose-chord` with `--stop-main` or
`--stop-renderer` to retain the same bounded modifier observations while agent input is
active. Candidate packets are routed to a separate safe observer, and existing stop
timing, trace completeness and success conditions remain enforced. Calibration and
injected timing packets are accepted only in this active observer mode and their
arbitrary fields are discarded; the passive mode still rejects marked injection.
Even when chord recognition fails, the runner attempts a native frontmost receipt
before teardown. This observation does not clear the original failed stage or make
unperformed follow-up mutation checks pass. The active UI continues to say input is
running; the passive "no agent input" wording is used only for passive mode.

The [instrumented current-helper frozen-main run](../computer-certification/2026-10-13-macos-current-helper-electron-main-stop-passed.json)
at clean `898c3874b1` passed every check using helper
`42e5f28a123a74b947ce93d0962494c497ab5f889fb68f6576c3ceb3793e48c5`.
Real human consent settled, the lease banner appeared, and Electron main was
OS-verified frozen for 707.2 ms. Physical input recognition occurred 407.2–408.4 ms
after the freeze began; full-chord recognition also occurred during the freeze,
228.2–229.4 ms before restoration, with 1.2 ms clock uncertainty. The independent
session observer recorded Escape with both Control and Command 475 ms after RED.
Recorded emission stopped within 5.2 ms of physical recognition and 0 ms of chord
recognition; app delivery stopped within 10.5 ms. The quiet tail, native frontmost
receipt, interrupted in-flight typing, subsequent paused-mutation refusal, mirrored
pause and released lease all passed. No resume was performed.

This establishes the narrow unsigned macOS/Codex/synthetic-fixture frozen-main stop
checkpoint for the current helper in the two-display environment. It does not explain
the preceding missing-chord attempt, which remains unchanged. Current-helper
frozen-renderer coverage, the broader app/privacy/profile matrix, Windows runtime
checks and installed-build signing/TCC attribution remain pending. All release gates
stay closed; signing remains deferred.

The [current-helper frozen-renderer run](../computer-certification/2026-10-13-macos-current-helper-electron-renderer-stop-passed.json)
at clean `d69b11dd7b` also passed every check with the same helper hash. Real human
consent settled and the lease banner appeared. The isolated renderer was OS-verified
frozen for 407.0 ms, covering physical recognition and the independently observed
full chord. The session observer recorded Escape with Control and Command 387 ms
after RED. Recorded emission tails after physical and chord recognition were 0 ms;
app delivery stopped within 1.8 ms. Quiet-tail observation, interrupted in-flight
typing, subsequent paused-mutation refusal, mirrored pause, released lease and native
frontmost receipt passed. No resume was performed.

Together these two reports complete the narrow unsigned macOS/Codex/synthetic-fixture
frozen-main and frozen-renderer stop checkpoints for the current helper. Having two
displays connected does not establish the complete display matrix. UI Pause/Resume,
broader app/privacy/profile coverage, Windows runtime checks, provider-built-in and
Chrome certification, and installed-build signing/TCC attribution remain separate
gates. Earlier failed reports remain preserved and all release gates stay closed.

Coordinate with the operator before launching. The real consent dialog must be answered
by a human for the single synthetic fixture. The operator then leaves input idle and
follows the window's instructions for Pause and Resume. Turns go through the real
composer and queue admission. The rehearsal checks correlated successful native
responses, fixture receipt, consent settlement, banner and live thumbnail, semantic
outlines, coordinate cursor, explicit resume, a fresh capture and lease/overlay cleanup.
It never auto-answers F5 consent or relaxes the physical-input pause boundary.

Reports distinguish a trusted click, a correlated answer forwarded by main, and server
grant settlement. They retain only booleans, counts, operation/outcome codes, geometry
and build identity. No screenshots, accessibility values, typed values, credentials or
raw errors are saved. Failures remain failures; the temporary window, fixture and state
are cleaned up afterward. This is an unsigned macOS/Codex/synthetic-app rehearsal,
not the signed installed-build or complete real-app certification matrix.

Append `--status-only` for a read-only diagnostic: three provider turns use tool discovery,
`computer_status` and `computer_list_apps`. A pass requires three successful native
metadata responses correlated at the inherited IPC boundary, not merely three completed
model turns. No consent, screenshot or lease is requested. The
[recorded discovery run](../computer-certification/2026-10-12-macos-electron-read-only-discovery.json)
observed all three metadata responses with no lease and no recorded provider error.
It proves that narrow observation path, not input or human controls.
A [subsequent diagnostic](../computer-certification/2026-10-12-macos-electron-read-only-timeout.json)
timed out with the provider turn still running and no native request. That result remains
failed. The observer now validates metadata response schemas as well as correlation.
Code inspection also found that a correlated computer-tool approval could lose its
request ID, request type and advertised choices during sanitization. The sanitizer now
preserves those control fields, validates decisions and generates fixed choice labels;
provider labels, warning/detail strings and tool contents are removed. Safety presentation
flags remain intact. An ingestion regression verifies the UI receives both the request
and its matching settlement. This fixes an independently demonstrated approval bug;
the earlier diagnostic does not establish it as that run's cause.

The [first recorded Electron consent attempt](../computer-certification/2026-10-12-macos-electron-consent.json)
confirmed human consent, main's answer forwarding and server grant settlement, but the
turn completed without native input. That run remains failed; its report does not identify
the subsequent blocker. The [separate consent/action-turn attempt](../computer-certification/2026-10-12-macos-electron-actions.json)
confirmed that the grant survived a turn boundary, successful native capture and
inspection, one fixture button press and Unicode typing, and the real lease banner.
It failed at human Pause: the operator reported no visible button. A
[follow-up attempt](../computer-certification/2026-10-12-macos-electron-controls-attempt.json)
confirmed Pause was initially visible after correcting lease-release recency, but the
operator could not click it before the 15-second window expired. The live card now
retains controls while the session has approved apps, labelled "Computer access" when
idle. With no grants remaining it retains the 15-second post-release activity window.
This extends the original transient-card design in response to operator feedback; it
keeps Pause and Revoke reachable without widening grants or resuming input.
A recent-input refusal during initial
lease acquisition also publishes its pause to the UI instead of leaving an invisible
latch. Unit and browser regressions cover both control visibility and dialog settlement.
These historical attempts remain failed, and all release gates remain closed.
An [additional pre-action attempt](../computer-certification/2026-10-12-macos-electron-no-action-attempt.json)
confirmed consent but completed the action turn without issuing native input. The
rehearsal now explicitly permits tool discovery as well as the F5 catalog; the prior
prompt restriction may have contributed, but the historical report does not establish
that cause. Pre-host diagnostics retain only known error tags from sanitized provider
activities and the latest host availability/reason, never raw provider output.
The [earlier foreground attempt](../computer-certification/2026-10-12-macos-electron-consent-timeout.json)
expired waiting for a human answer: no trusted click, forwarded answer, grant or lease
was observed, and no input was emitted. Pause/Resume, the subsequent fresh screenshot
and coordinate-click sequence remain pending in the real Electron workflow.

The [native-consent inspection attempt](../computer-certification/2026-10-12-macos-native-consent-inspection-failure.json)
at commit `856ae44523` passed the main-owned native consent dialog, grant settlement,
activation and capture, then failed at `inspect` with `Execution` before any input or
human controls. That report predates safe execution-error classification and does not
identify the cause. A separate
[background inspection diagnostic](../computer-certification/2026-10-12-macos-background-inspection.json)
passed at node limits 20, 100 and 400, returning 12 nodes within 30 ms each. The
helper stayed suspended, with no execution permit, capture, activation or input; the
only scripted grant was for the diagnostic's own synthetic app. This does not prove
inspection through Electron or a provider session.

Append `--controls-only` to the Electron command to isolate native consent, persistent
Pause visibility, human Pause/Resume, refusal of an untrusted resume, fresh capture and
lease/overlay cleanup. This mode activates and captures the fixture but issues no
inspection, pointer/keyboard or semantic actions. The
[recorded controls run](../computer-certification/2026-10-12-macos-native-controls.json)
passed all those checks and submitted all three turns through the real composer.
It still **failed overall** because the combined activity/thumbnail push check and
thumbnail rendering failed. That aggregate result does not identify which push was
absent. Those checks remain required, since app activation is a
mutation. The transport regression exercises private IPC through the real server push
bus to a WebSocket client; the rehearsal now counts IPC activity and action captures
separately, retaining no content, to locate the outstanding failure.

Append `--actions-only` instead to investigate the full inspection, semantic input,
Unicode typing and coordinate workflow without repeating human Pause/Resume. The
operator approves the native fixture dialog and stays idle through the action turns;
this mode does not claim controls evidence. The three diagnostic modes are mutually
exclusive. Exact known F5 execution messages map to fixed codes; unknown details are
discarded. Neither a completed model turn nor an action with a failed follow-up capture
is treated as proof of that capture.

The [actions-only trace](../computer-certification/2026-10-12-macos-native-actions-trace.json)
then passed native consent, capture, inspection, semantic press/focus, Unicode typing,
the next-turn coordinate click, semantic and coordinate overlays, and lease cleanup.
It observed 12 IPC activity events and one thumbnail reaching the renderer, but still
**failed overall** because the live-card image was absent at the end. The store replaced
each action with the next one, discarding a previous thumbnail when later actions
provided no screenshot. The live card now retains a separately labelled last capture
while displaying the latest action. Grant changes, backend changes and reconnects
discard that capture; the earlier image is never attached to a later action. Store and
browser regressions exercise this sequence and revocation. The earlier inspection
failure remains unexplained; a later successful observation does not retroactively
turn that failed report into a pass. The failed reports remain part of the evidence.
The [corrected-renderer attempt](../computer-certification/2026-10-12-macos-corrected-renderer-pre-input-failure.json)
at `073e4ccb60` passed native consent, activation, capture and inspection, but stopped
before any semantic or keyboard input reached the helper. Its last observed request
was app resolution, with no tagged helper failure. It did not reach thumbnail validation
and remains failed; it does not establish why the agent stopped. The shared tool
boundary now publishes fixed, session-scoped outcome codes for failed calls, including
failures before native dispatch, without names, input values or raw error text. Unknown
details remain discarded and model-facing errors remain intact. The rehearsal captures
those ephemeral WebSocket codes separately from native IPC outcomes. Prompts explicitly
use the exact app ID in every app argument and request post-activation captures instead
of leaving those choices to the model. These changes improve reproducibility and
diagnosis; they do not retroactively identify this attempt's cause or weaken any check.
The [instrumented attempt](../computer-certification/2026-10-12-macos-instrumented-pre-type-failure.json)
at `daa20cec52` observed successful capture, inspection and two semantic-action
responses and emitted one thumbnail. It then ended without a typing request or a tagged tool failure, so it
remains failed. Inspection of the access result found a misleading representation:
full-tier grants permit typing, but their stored `allowTyping` flag is false because
that flag is only an extra click-tier permission. Access results now report derived
`typingAllowed`, using the existing authorization predicate, and tool descriptions
explain the distinction. Stored grants, helper authorization, click-tier consent and
secure-field protections are unchanged. A regression confirms a full-tier grant reports
effective typing permission without changing its stored flag or opening another consent
request. This is a demonstrated presentation defect, not proof of why that model turn
stopped. Future failed runs also record content-free thumbnail visibility/load booleans
at cleanup, separately from the overall workflow checks.

The [passing Electron actions run](../computer-certification/2026-10-12-macos-electron-actions-passed.json)
at `31d4458d19` then passed all 18 actions-only checks through the real composer,
provider, main and helper. Native human consent settled once; successful capture,
inspection, semantic press/focus and Unicode typing were correlated; a subsequent
turn took a fresh capture and delivered the coordinate click. The fixture independently
reported two presses and receipt of the expected synthetic text. Twelve activity events
and four thumbnails were observed; the live-card image was visible and loaded. Semantic
outlines, the coordinate cursor and lease/overlay cleanup passed, with no recorded
provider or tool-outcome error. This confirms that narrow unsigned Codex/synthetic-app
workflow on one Retina display, not the complete release matrix. Pause/Resume was
excluded and retains its separate earlier evidence. The earlier failed runs remain
failed, and this later success does not prove their exact causes. Signed installed-build
attribution, real apps, stalled-host/hung-renderer stop latency, multi-profile/display
isolation and Windows runtime still require their own proving runs. Native, provider
built-in and Chrome release gates remain closed; signing remains deferred.

For background inspection without changing focus or starting a provider session:

```sh
bun apps/desktop/src/computer/rehearseInspectMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper --output /tmp/f5-background-inspection.json
```

For the Phase 0 background-delivery spike (accessibility press, setValue, selected-text
typing and app-filtered capture on a background fixture, each with verified read-back, and
checking the frontmost app never changes), build the helper and run:

```sh
bun apps/desktop/src/computer/rehearseBackgroundMacos.ts --helper apps/desktop/dist-native/mac-arm64/f5-computer-helper \
  --real-app com.apple.TextEdit --real-app com.apple.Notes
```

Each `--real-app` must be a running app from `COMPUTER_BACKGROUND_POLICY.certified`; it is
probed read-only (inspect and app-scoped capture). Real-app press, setValue and typing stay a
manual certification step, so this report alone does not certify an app. The script
refuses to overwrite an existing receipt and fails when the helper lacks `background-ax-v1`.

The [current read-only preflight](../computer-certification/2026-10-12-macos-gate-preflight-856ae44523.json)
confirms development permissions on one Retina display. Signing remains deferred;
the native release flags and provider built-in/Chrome certification registries remain
closed. These unsigned results do not establish installed-build TCC attribution,
Windows runtime safety, mixed-display behavior or the complete real-app matrix.

### Build prerequisites and bounded replay state

Desktop development builds attempt the native helper build on macOS and Windows. A
missing development toolchain produces a warning and `helper-missing`; there is no
runtime compilation or download. Release artifacts always build and bundle the helper,
even while certification gates are closed, so the shipped binary and packaging can be
certified. This requirement is intentional.

macOS requires Xcode with the Swift toolchain and macOS SDK. Universal artifacts build
both arm64 and x86_64 slices and combine them with `lipo`. Windows requires Rust, the
requested `x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc` target, Visual Studio C++
build tools and the Windows SDK. Release builds fail if the required helper cannot be
built. Signing remains a separate release/certification requirement; unsigned rehearsal
results do not open a release gate.

Replay tombstones are retained within their authorization generation, including failed
admissions. They have a fail-closed ceiling of 65,536 per dispatcher/controller. Expiring
them by time would let a delayed request execute again. Session replacement clears the
old session's desktop admissions; lease generation changes clear older admissions. An
observation-only session reaching the ceiling must restart its provider session. An MCP
client reinitialization gets a new `Mcp-Session-Id` and dispatcher; requests using the
retired transport session are rejected. Mutations are never retried automatically.

Consent keeps the approved plan's defaults: grantable apps are selected, typing for
click-tier apps and remembering grants are off. Ambiguous app searches return candidates
without opening a consent card. The user must explicitly allow the displayed selection.
Resume requires a trusted gesture in a local F5 window; remote clients can pause but
cannot re-arm native or Chrome control. The server mirrors resume only after main's
successful acknowledgement.

## Claude in Chrome discovery follow-up (2026-10-18)

The [native-host discovery attempt](../computer-certification/2026-10-18-claude-chrome-native-host-discovery.json)
identified SDK `0.3.295`, darwin arm64, and executable SHA-256
`0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70`.
The macOS sandbox rejected the isolated launch before any registration was observed.
The operator's Chrome-family native-host snapshots were identical. No host names,
allowed origins, target paths, candidate descriptor or certification are inferred.

The server master switch is now enforced. Certified descriptors must pin SDK version,
architecture and executable hash; reporting distinguishes not-certified, platform,
executable drift and unverifiable executables. A test guards SDK-version drift for
any future certified Claude descriptor. Production never loads a candidate descriptor.
The candidate and real Chrome runner remain blocked on successful C1 discovery;
the signed installed-build run and C5 gate flip have not occurred. Existing gates
remain closed and Claude always keeps `--no-chrome` in these unavailable cases.

Implementation checks and remaining prerequisites are recorded in the [follow-up verification record](../computer-certification/2026-10-18-computer-followups-verification.md).
