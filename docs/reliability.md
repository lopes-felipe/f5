# Reliability and recovery

> Contributors: how provider deliveries, retries and recovery stay safe across crashes and reconnects.

Provider prompt transports belong to the server service scope. Disconnecting an RPC caller does not cancel a dispatched transport. Lifecycle locks protect preparation and settlement; stop, approval answers, user-input answers and supported steering can reach the live adapter while a prompt remains unresolved. A stopped or replaced generation cannot be restored by its old dispatch result.

The delivery database is the backlog. Sweeps load at most 64 candidate ids in thread order, rotating through thread ids. Payloads are loaded individually and claims are conditional. Ordinary dispatch ownership is per thread; controls have their own path. Terminal completion, interruption, error and rewind durably release accepted reservations; deleting turn projections cannot restore them. Native receipts identify accepted deliveries. Unavailable, local-only or legacy history does not establish absence. A new history turn alone does not correlate a delivery, so uncertain sends remain ambiguous and require explicit recovery rather than automatic resend. History identity, provenance, session origin and coverage are retained with the dispatch baseline for diagnostics and future provider correlation. They do not themselves correlate a request with a native turn or resolve ambiguity. Local history carries a backend runtime identity; Codex pagination identifies complete provider-persisted coverage.

Workspace saves require either `create` or a matching SHA-256 base hash. All F5 profiles share connection-owned SQLite file locks under the profiles-root lock directory. Writers flush a temporary file on the destination volume. Create uses an exclusive hard link and fails explicitly when the filesystem does not support it. Matching saves recheck the base under the lock and atomically rename the temporary file. Existing permissions are preserved; newly created files use the process umask; symlinks, directories, oversized and unsupported binary content are rejected.

External editors do not acquire F5 locks. A non-F5 writer can still change a destination between the final hash check and a matching rename. Preserve base contents and draft text when resolving a conflict. Live filesystem watching is a separate roadmap item; refresh remains necessary to discover external changes that are not observed by an existing query refresh.

Editor recovery uses IndexedDB transactions and independent window branches. Recoverable branches are offered explicitly. Save acknowledgements clear only the revision sent, and advance the base of newer edits without replacing their text. A duplicated window claims a new branch through document-owned Web Locks. Without Web Locks, each document forks and leaves older branches for explicit recovery. Storage errors leave text in memory and display a recovery warning. Recovery is local to the browser origin and profile; clearing browser storage removes it.

Terminal snapshots and events carry a backend epoch, terminal generation and state revision. Recovery subscribes before reading a snapshot, buffers at most 2,000 events or 4 MiB, and replays only a contiguous newer suffix from the same epoch and generation. A gap, overflow or lifecycle race triggers a fresh read. Snapshot reads never spawn terminals or replay input.

Each client has eight ordinary RPC slots, one stop slot, two answer/steering slots and one recovery slot. Ordinary retained payloads are capped at 80 MiB; controls have independent byte admission. Overload is returned as `RpcBusy` with `retryable` and `retryAfterMs`. Reads retry an explicit pre-execution busy rejection at most four times, honoring the advertised delay within the original request deadline. Mutations are never retried by the transport. Startup recovery buffers at most 2,000 events and 32 MiB; an overflow invalidates the in-flight snapshot and retries with bounded backoff.

The connection banner leaves loaded content and local drafts usable. Stop, cancellation, approval answers and supported steering remain available on a connected socket during resynchronization. Other mutations are refused until startup reconciliation completes and are never queued for automatic sending after reconnect. These controls do not make SQLite synchronous writes interruptible; the helper-process decision remains measurement-gated.

## Client stream recovery

`apps/web/src/orchestration/eventRouter.ts` owns event batching, recovery buffers,
retry timers and the router's enqueued/committed cursors. Its scheduler is injected,
so ordering, overflow, hidden-tab flushing and disposal are tested without a DOM.
A failed apply drops the offending batch, resets the enqueued cursor to the
router's committed cursor and schedules snapshot recovery in one microtask. It
never retries the same poison batch on every animation frame. Recovery invalidates
and re-warms previously loaded affected threads, including background threads.
Three failed batches within sixty seconds stop automatic recovery and show a Reload
app action. This error remains visible even when the optional disconnect surface
is disabled. Local drafts stay mounted and editable.

Tail and history responses never advance the global stream cursor. Tail coverage
applies to replaced detail fields; history coverage applies only to newly inserted
rows. Summary/session/project events continue through the stream independently.
Eviction, rewind and backend replacement release coverage. Welcome carries a
per-process backend incarnation (the desktop-provided identity when available).
A replacement resets stream/detail state and invalidates pending reads, preserving
composer drafts. Snapshot finalization drains pushes received during hydration
before announcing synchronization. The synchronization controller owns welcome
recovery, warming, rewind-draft tickets and reconciliation; the root route supplies
routing, settings and browser scheduling. A minute probe waits at most five seconds
for a fixed server sequence. Full snapshots still run every ten minutes to detect
reducer divergence. Disconnect and disposal cancel the active probe cycle.

Per-page diagnostics report cumulative snapshot, gap, overflow and poison counters,
connected time and fixed apply-duration buckets every five minutes and on hide.
The server deduplicates report sequences in a 256-session LRU. Metrics use only
client-kind and fixed bucket labels, never session IDs.

Recovery clears buffered events without releasing hydration owners or evicting
visible messages. Reload uses the upload/draft persistence guard and offers a
recovery download, including when local storage fails.

Workspace watchers retain rename hints until observation and impose a maximum
debounce delay. One registry poller observes at most four unavailable/missing
paths concurrently. Each observation releases its polling slot; dirty hints
schedule one bounded rerun. Healthy watchers perform no periodic directory scans.

Background Git refresh downloads into a unique temporary ref without writing
`FETCH_HEAD` or the remote tracking ref. It promotes the result with a short,
fail-fast background repository lock and a compare-and-set against the previously
observed tracking SHA. A concurrent pull keeps its newer ref; cleanup removes the
temporary ref. Network waits do not hold the shared user-operation lock. First-use
cleanup examines up to 256 namespace refs and removes only refs older than thirty
minutes, with a compare-and-set for each deletion. Recent refs from other profiles
are preserved. Legacy UUID refs use filesystem age, never commit age. Git versions
without the isolation options use a compatible refspec fetch under the repository
lock, with one compatibility warning. This older-Git path can hold the lock during
a bounded network fetch; it prevents concurrent user fetch/pull metadata races.

Temporary `refs/f5/status/*` refs are ordinary Git refs: they can appear in
`git log --all`, `for-each-ref`, backups and mirror pushes. Git has no portable ref
namespace ignored by all of those tools. Normal completion removes the temporary
ref; after a crash it can remain until this repository's next first-use sweep, and
recent refs are retained for thirty minutes to protect other live profiles.

A stop, archive or thread-wide interruption cancels older admitted, unstarted
starts and steers. A claimed queue prompt cancelled this way stays visible as
failed with its original text and requires explicit Retry. Automatic retry would
resurrect work the user just stopped; ordinary capacity overload still retries
without consuming a provider-delivery attempt.

Codex process exit/error rejects pending RPCs immediately, including contexts
replaced by a new session. Written requests reject even if their responses remain
buffered. The matching context drains notification sources through EOF, capped at
1,800 ms, before its terminal lifecycle event; replaced contexts never close their
replacement. Stderr framing retains partial UTF-8/lines until source closure.
Terminal exit flushes buffered assistant text and finalizes streaming messages even
when the provider dies without sending item-completion notifications.

Compaction packs whole message/output groups into transactions toward 2,000
events. Larger groups run alone; groups above 50,000 events are reported and
skipped. Rewrite and chunked deletes commit together, and counters update only
after commit. Oversized groups retain their complete original history and its
storage cost; subsequent maintenance passes report and skip them again. There is
no automatic splitting or reclamation of these groups because a partial commit
would break replay equivalence.

File-backed persistence owns two query-only snapshot readers, created after writer
migrations. Foreground tail/history reads have their own connection; startup and
background snapshots use the other reader. Each complete response reads its
sequence and constituent repositories in one deferred transaction. A cooperative
two-second deadline is checked before each subsequent statement and returns a retryable
read failure on expiry; a completed response is retained. Full bootstrap and startup
snapshots opt out of this interactive budget so large profiles can finish loading. Memory persistence keeps its single database and preserves an
already-held writer transaction. Transactions retain their connection lease until
commit or rollback completes.

Deleted threads retain their metadata in the engine but release message, plan and
activity arrays at bootstrap and after commits. SQLite keeps the original history.
A command targeting a deleted thread (or an active thread referencing its plan)
loads the retained details into a temporary decision model; no message state is
truncated to meet a memory budget. Decision parity covers every thread-command
schema, and a file-backed restart test verifies append/completion behavior.

Migrations 124–126 add nullable terminal-receipt origin identity, retry due times
and pending/due/age indexes without rewriting event JSON. Due reads use pages of 64;
continuous retries back off with jitter up to thirty seconds. Malformed rows are
deferred separately, and removed-thread receipts are acknowledged so they cannot
block later pages. After ten failures, a receipt leaves automatic retry but retains
its original event and last error for repair; the thread receives a visible repair
activity. Orphan detection considers only receipts for the current instance,
generation and turn. Applied/exhausted receipts trigger another bounded dirty-thread
reconciliation without restarting. Exhausted counts and oldest eligible receipt
age have static metrics. Lifecycle writes compare the originating instance, generation
and turn. Legacy receipts cannot settle a replacement generation. Receipts remain
pending until replay-critical effects finish; deterministic command IDs make a
retry after partial application idempotent. A file-backed compatibility check creates
the schema through 123, interrupts an upgrade, closes every connection, upgrades to
126 and reopens with the preceding migration catalog and explicit-column receipt
queries. Node and Bun execute the same check; it does not launch a released beta binary.

Drainable workers track accepting, draining, failed and closed states, settle
waiters on failure and account for accepted entries until processing completes.
Notes, skills, automatic titles and queue wakeups coalesce by owner. Explicit title
regeneration rejects visibly when busy. Lossless subscribers use blocking count
admission; large provider events have no implicit frame ceiling. Engine admission
allows 1,024 ordinary entries/32 MiB and 64 separately reserved controls. Control
reservations survive intent commit until reactor completion or recorded failure.
A control that the reactor has not started within 30 seconds is fenced against late
execution, reported as not sent, and released after its failure activity is recorded.
Waiters fail instead of hanging. Claimed controls retain their reservation through
processing, including slow maintenance; expiry never retries an ambiguous action.
The reactor processes controls after its current item, with an independent control
subscription so blocked bulk admission cannot hide stop or approval events. Stops
cancel older queued starts and pending durable deliveries; claimed starts check a
stop fence before dispatch. Controls retain their originating session/turn identity.
Codex notification preparation has separate bounded byte/count admission and
explicit incomplete-history recovery, described below.
Queue retries use one earliest timer per thread, and actionable scans rotate
through pages of 64. Startup visits every page up to a captured high-water ID
before periodic scans begin, without retaining the whole actionable inventory.

Hydration retains at most 2,000 pending detail events or 32 MiB per thread. Overflow
discards the unusable buffer and fences older tail responses until a fresh read
covers the overflow sequence. It never applies a truncated buffer. Retention also
accounts for tasks, notes and coverage metadata; store persistence only observes
fields that are actually saved locally.

Authentication and connecting WebSockets have ten-second deadlines. Reconnect and
disposal cancel old attempts; disposed transports reject even no-timeout calls.
Server ping/pong checks run every thirty seconds and terminate clients after two
missed replies. Socket shutdown also bounds peers that never acknowledge close.
Normal terminal close and shutdown retain source listeners through termination,
finish decoding, and flush before removal/reopen. Windows descendant teardown is
asynchronous and capped by the remaining shutdown budget.

Application shutdown coordinates admission, history flushes, producer termination,
ingestion drain and log closure against one absolute 1,800 ms deadline, before
persistence layers close. Phases run components concurrently, record their durations
and mark failures/deadline expiry as incomplete. Earlier phases stop 450 ms before
the global deadline, reserving 300 ms for ingestion drain and 150 ms for log closure;
unused time carries forward. These are cooperative budgets, not guarantees against
a blocked event loop. Terminal disposal is awaited and
idempotent, keeps source listeners through termination, flushes final decoder output,
and writes histories atomically with per-terminal serialization. Dirty histories are
flushed before inactive-session eviction. The desktop quit/reopen scenario still
requires qualification on a host where Electron can launch.

Native and canonical provider logs share one asynchronous append/rotation registry
per canonical path. Record boundaries and the existing history format are preserved.
Admission is bounded, repair evidence is never shed, critical records wait for append,
and transient failures retry without blacklisting a thread. Partial final lines are
removed before another append; they never prove completion. Both repair tools ignore
unterminated tails, including valid JSON without the final newline. A log failure is reported
while authoritative runtime events and terminal receipts continue to publish.

Reducer batches reuse a private thread-array copy and leave the published input
state untouched. Text-only appends preserve timeline/row structure and attachment
indexes. Transient text revisions retain at most 32 suffixes/64 KiB, including
skipped renders; hydration, replacement and expired provenance rebuild safely.
Reasoning display keeps its whitespace trimming while processing only new suffixes.
The parser advances long plain paragraphs, fenced code, compatible lists, blockquotes
and established tables incrementally. Ambiguous syntax and block boundaries retain
the validated parsing path. Deterministic tests compare the incremental fragments
with full parsing and bound processed characters over 1,000 appends.

Codex notification preparation has entry and byte admission limits, with separate
capacity for lifecycle/control notifications. A valid large frame can run alone;
stdout and RPC response handling never wait for preparation. Exhaustion interrupts
the originating live context, blocks new turns, and publishes an explicit incomplete
history error after admitted output. The marker is persisted in runtime metadata,
fenced by instance/generation, and retained through replacement. Verified complete
plain-text native history can repair completed messages through a separate internal
command; live deltas still cannot reopen completed messages. Partial, divergent,
replaced, deleted, reasoning or tool history never clears the marker. Full non-text
history repair remains required for those cases. Queue entries/bytes/age and provider
fan-out backlog are observable with static labels.

Shutdown orders provider-event delivery before ingestion, then checkpoints and
provider command work. It waits for handoffs that are still entering the bounded
workers. Workflow subscriptions/retry timers, compaction subscriptions and native
cleanup subscriptions have separate source scopes, closed during admission shutdown;
their admitted workers participate in the same absolute deadline. Cyclic drain
ordering is reported as failed rather than hanging teardown.

The chaos suite now uses real sockets and the production router/store for a dropped
connection and an overflowing slow connection followed by an oversized startup snapshot.
A separate server process is killed and reopened on the same database before send,
after native acceptance without acknowledgement, and after acknowledgement plus
output projection. Unsent intent is replayed once; ambiguous/accepted work is not
resent. The precise acknowledgement-to-output window is also held at an assistant
projection barrier: after restart, an explicit recheck recovers exact output from
surviving scripted native history without another provider send. Restart also exercises a malformed receipt ahead of 65
stale-generation receipts across pages. A killed log-writer process verifies both
repair tools against a partial final batch and a subsequent writer reopen.

A real MSP host is now killed after its visible assistant prefix. The test checks
that the turn ends in error, the real client store converges in lifecycle as well as
message text, and the owned process exits. A separate barrier test keeps final MSP
output ahead of its single terminal event. Session scopes and unexpected-exit cleanup
are owned by the adapter; explicit stops await closure. Client and server share
terminal session-to-turn transitions so an errored turn cannot remain completed only
in the browser.

The Claude crash/resume gate was exercised in a separate killed F5 process with the
real adapter and a scripted SDK query. The native transcript survives with a complete
assistant answer, but resume exposes partial runtime-local history and does not
reconstruct the missing suffix. Coalescing is declined for Claude; guarded append
projection remains its optimization. This fixture does not certify the external CLI.

The optional production-renderer lifecycle phase switches threads and loads older
history while ten threads stream. It checks stop and approval through the real
central admission queue with 1,024 ordinary entries held, provider-crash copy, and
draft preservation. History restoration selects visible row geometry rather than
recycled DOM order, waits for committed rows, and yields to wheel input, cancellation,
thread replacement or following the tail. Initial end positioning does not trigger
an unnecessary history load. Reactor/writer saturation is covered separately; the
browser's provider wire is scripted.

Unknown or non-text incomplete native histories retain their admission fence; the
implemented automatic repair proves only complete plain-text histories. Desktop
qualification now uses the same scripted Codex stdio host as the real-manager and
engine/client integration checks. The smoke runner exercises stop, approval, route
switching while output streams, and a full quit/relaunch with both an active provider
and terminal, checking persisted message prefixes, terminal history and the draft.
It also checks terminal history through backend restart. Electron launch remains
unavailable on this host, so these desktop scenarios still require a supported runner. Hosted Windows
validation and three green main pushes remain separate acceptance requirements.
The server optimization passes its pinned full comparison in `docs/performance.md`;
full browser/desktop performance qualification still requires a supported host.
These results do not establish hosted M0 acceptance or complete platform qualification.
Conditional replay, SQLite workers, read-model slimming, visual-matrix expansion,
and the WebSocket server split remain gated by their stated evidence or coordination
requirements. Engine commit side effects now live in `orchestration/commitSideEffects.ts`
inside the same transaction, with focused tests for every handler. Claude assistant
text handling and receipt retry scheduling were extracted while their lifecycle
changes were already in progress.

## Durable reactor catch-up design (not enabled)

The current PubSub delivery remains unchanged. A durable cursor must acknowledge
processing, not subscription, and must never infer delivery certainty from an ack.
The owning reactor is the only writer of its cursor; rollback restores that owner
before catch-up can resume. Event compaction must retain every event above the least
acknowledged cursor of any enabled reactor. Startup validates cursor/schema versions
and reconciles pending operations before new live admission.

| Reactor                | Durable operation identity and fencing                                                | Ack/reconciliation boundary                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider commands      | Command/event ID plus captured instance, generation, turn and approval/input identity | Ack after a durable delivery result. A crash after send but before ack is ambiguous until native history proves acceptance. Stop must target its original generation; resolving the current session during replay is unsafe. |
| Checkpoints            | Thread, turn, checkpoint operation ID and expected generation                         | Verify the Git ref/filesystem result after a crash, then persist projection/receipt before ack. Rewinds also retain their workspace reservation and expected history generation.                                             |
| Native-session cleanup | Tombstone/cleanup operation ID, native session ID and originating instance/generation | Check that the resource is still unclaimed, reconcile whether deletion happened, then ack. Replacement sessions never inherit an old cleanup operation.                                                                      |
| Workflow services      | Workflow ID, state revision, phase and step/turn operation ID                         | Persist phase/side-effect ownership before provider/worktree operations; reconcile their durable identities before ack. A replay cannot create another branch, session or reviewer.                                          |
| Session notes          | Thread and source event watermark/revision                                            | Ack only after the notes write commits against its expected source revision. Superseded computations may complete without overwriting newer notes.                                                                           |
| Project skill sync     | Project/root identity and desired skill revision                                      | Reconcile atomic file contents and authorization/root identity, then acknowledge that revision. A later root/revision supersedes old work.                                                                                   |
| Compaction requests    | Maintenance operation ID plus complete event-group identities                         | Each group rewrite/deletion commits atomically. Ack follows committed progress; restart reconciles progress without replaying a partially prepared group. Cursor retention constrains future compaction.                     |
| Next-turn wakeups      | Queue entry/command ID, queue revision and session generation                         | The delivery database owns send/acceptance state. A wakeup can be repeated; an ambiguous delivery cannot be resent. Ack only after dispatch disposition is durably recorded.                                                 |

No reactor-ack tables or replay switch are introduced. Each reactor requires crash
injection before its side effect, after its side effect but before durable result,
after durable result but before ack, and during cursor persistence. Restart, compacted
history, duplicate replay, generation replacement and single-owner rollback must all
pass before that reactor can opt into catch-up.

Provider event ingestion waits for ordinary command admission instead of dropping
streaming deltas when the command queue fills. Client admission still rejects
visibly on overload, and controls retain reserved capacity. Provider event
persistence retries are bounded to three attempts; a lasting failure reports an
incomplete-history warning, fences new sends and releases the event lane. An
in-memory origin fence remains if SQLite cannot persist the warning.

The composer offers **Review recovery** for incomplete history, including turns
with reasoning, tools or images that cannot be proven complete automatically.
Explicit acceptance stops the inspected provider generation before clearing its
matching marker. It never resends the interrupted turn; drafts remain editable.
A stale generation or marker requires reviewing the current warning again.

Codex snapshot backfill preserves leading/trailing whitespace and line endings
exactly. This also applies to the existing assistant-delta backfill path, whose
historical trimming could change provider-authored content. Persisted messages
are not rewritten solely to normalize their whitespace.

Terminal ingestion never waits for a provider launch lock in the shared worker.
If the source's thread is busy, its durable receipt remains pending for the next
retry tick without consuming a failure attempt; startup input and other threads
continue. Retired receipts flush and complete only their originating turn's output
before acknowledgement, preserving the replacement session and active streams.
Runtime receipt recovery reports exhausted receipts only. Orphan session/turn
classification runs once at startup and skips launches already in progress.
