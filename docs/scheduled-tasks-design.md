# Scheduled tasks

Task definitions and run bookkeeping use a dedicated SQLite store, following NextTurnQueueStore. Fire deduplication, cursor advancement, ownership, capacity and recovery require transactional state. Thread origin is event-sourced so attribution survives replay.

Runs share the transport-independent turn submission path used by the UI and Agent Bridge. Stable identities and immutable commands are persisted before side effects. Existing worktree preparation, setup scripts, queue admission, provenance and delivery receipts remain authoritative. Worktree runs require isolation; preparation failure cannot fall back to the project root.

Run lifecycle follows associated submissions and turns, with ordered attention episodes and durable notification intents. Unknown delivery retains ownership and requires user reconciliation. Task edits apply to future admissions.

Croner 10.0.1 evaluates timezone-aware cron without autonomous timers; cronstrue 3.37.0 supplies descriptions. The shared wrapper restricts grammar and tests DST progression, skips gaps and canonicalizes repeated wall times to their first occurrence. Catch-up consumes the persisted first unconsumed occurrence and advances directly beyond evaluation time.

Agent scheduling requires an explicit f5.schedules grant and supervised execution. Execution authority is independent of creator provenance and is checked before delivery. Notifications are durably leased and acknowledged; an OS presentation followed by a crash before acknowledgement may cause a duplicate.

## Stability integration (#189)

Scheduled execution uses main's command admission, commit side effects, filtered projection pipeline, delivery attempt receipts and coordinated shutdown. User-answer continuations are linked in `commitSideEffects.ts`, in the command/event transaction together with queue insertion and frozen execution settings. The lifecycle projector retains ownership until that insertion commits; rollback leaves both the input resolution and continuation uncommitted.

The final delivery handoff rechecks scheduled authority, cancellation and capacity after asynchronous preparation, alongside the shutdown fence. Capacity wakeups query only pending deliveries in the affected thread. Scheduler subscriptions and timers stop during shutdown admission; already-admitted submission workers have a separate drain barrier. Durable reserved identities and the existing delivery recovery path remain authoritative after restart.

Main's migrations 124–137 are unchanged; Scheduled Tasks is migration 138 and malformed-row quarantine is migration 139. Normal startup runs only the numbered migrations. Known migration-ledger identities from unreleased development builds are repaired only by the opt-in command below, with F5 stopped. The script inspects by default; `--apply` first creates a consistent SQLite backup, then transactionally applies missing main migrations and repairs those exact ledger identities. Existing task/run evidence, ownership, notifications, origin and projector cursors are retained.

```sh
bun apps/server/scripts/repair-unreleased-scheduled-tasks.ts /absolute/path/to/state.sqlite
bun apps/server/scripts/repair-unreleased-scheduled-tasks.ts /absolute/path/to/state.sqlite --apply
```

Malformed task definitions and run payloads are retained in `scheduled_task_quarantine`, with the source task disabled and unsent work fenced. Unknown/in-flight execution keeps ownership and capacity until its evidence is recovered; it is never automatically resent. Healthy rows and projectors continue. Restoring a quarantined record requires explicit database recovery from its retained payload or backup before removing its quarantine entry.

Global startup readiness closes automatic sends. Human answers remain subject to ownership, cancellation, authority and capacity checks, but do not wait for the global automatic-dispatch readiness latch. A persistent reconciliation failure is fenced per execution; a global storage failure keeps automatic dispatch closed and retrying.

Main's selective renderer persistence remains in place. Explicit read/unread actions separately persist their receipts, including bulk acknowledgement, without writing renderer state for every streamed event. Local acknowledgements also survive backend-incarnation rehydration.

Integration verification: `bun fmt`, `bun lint`, workspace `bun typecheck`, frozen dependency installation and `bun run upstream-ports:check` pass. The ledger's evidence links follow the extracted helpers; coverage pins and port decisions are unchanged (the checker reports that authoritative remote provenance is unavailable locally). Focused server coverage passes 97 tests, real WebSocket restart coverage passes both project-root/worktree cases, renderer-store coverage passes 66 tests, and the sidebar passes all 51 browser tests.

`bun run test:full` completed both stages. Its exhaustive real-Git matrix passes all 147 tests. The workspace stage has one intermittent 15-second timeout in the unchanged `worktreeClaims` disposable-path cleanup test; 5,100 other server unit tests pass, as do the other workspace suites and server integration/smoke stages. The timeout case passes in isolated retries on this branch and the preceding main/stability checkout. The full command therefore exits nonzero; it is not reported as a green run. Tests use Node 24 with the installed VS Code CLI directory on PATH to satisfy the editor-discovery fixtures.

## Review corrections

The active change set is now in the requested worktree on `f5/scheduled-tasks`, rather than only in the external implementation checkout. Existing checkouts and user changes were preserved. The old `feat/scheduled-tasks` and detached baseline worktrees were not deleted: the repository policy prohibits deleting worktrees or branches. The former implementation checkout is a detached backup of the earlier draft; it is not the delivery location.

The server review corrections include:

- Turn outcome and quiescence, rather than diff checkpoint availability, determine success. Interrupted and usage-stopped turns keep ownership while recovery is outstanding. Late source-turn events cannot overwrite a durably linked continuation decision. A canceled continuation admission fails its queue transaction instead of silently losing scheduler attribution.
- A shared cancellation fence cancels queued receipts and abandons provably unsent delivery rows before releasing ownership or capacity. Delivery workers use the submission command identity, honor cancellation before claim, and can be woken when capacity returns. Explicit user resolution also fences tracked sends before abandoning unknown delivery.
- Startup, engine, watchdog and event listeners retry failures with capped backoff. Individual dispatch failures are isolated. Cron evaluation errors are typed effects. Startup delivery remains closed until reconciliation succeeds.
- Command reservation no longer sets the submission-start marker. Safe recovery reuses the persisted command and identities, verifies the command hash, and consumes budget once. Bootstrap timeout age uses its start time; a long capacity wait cannot prematurely time it out. Host/provider/usage lookups run outside write transactions, and reconciliation shares one orchestration snapshot per sweep.
- Disabling does not require an available provider, future cron occurrence or remaining budget. Metadata-only edits work for expired schedules and preserve schedule cursors and authority. Enabling and execution edits retain validation. Re-enable and execution adoption enforce the agent task cap.
- Global disabled intervals have bounded history summaries; exhausted one-shots are disabled on cutover. Transient provider probes are distinguished from missing providers. Ordinary delayed single fires retain the schedule trigger.
- History uses a validated opaque keyset cursor. Notification bodies use readable messages. Production constructs the lifecycle store/projector once.

Two review suggestions need qualification. Removing a thread settles a provably unsent run as `failed/thread_removed`; a known active turn or uncertain provider handoff retains ownership until stopped or reconciled. Immediate release in that case would permit overlap. Notification claims already use an atomic exclusive SQL lease, so two owners cannot simultaneously claim the same unexpired notification. Phase 2 adds desktop/browser capability negotiation and presentation.

## Delivery and verification

Phase 1 implements the server core, including the review corrections above. Phase 2 adds the Scheduled management route, project-scoped execution defaults, shared provider/model/options and prompt/skill controls, explicit NL confirmation, run history and origin badges. NL output is validated by the cron wrapper. Native notifications use the existing incarnation-bound Electron handshake and a leased outbox independently of renderer or computer-control permission; browser delivery falls back to in-app notices and wakes on pushes/reconnects/lease expiry. Ordinary thread notices check associated turn IDs, preserving notifications for later independent user turns. Phase 3 restores opt-in local MCP activation, adds explicit per-client scheduling grants, and exposes six tools through the same service. Persisted authority is rechecked before sends and continuations; revocation fences unsent work. Existing and new clients receive no implicit scheduling grant.

Current verification uses Node 24:

- `bun fmt`, `bun lint` and workspace `bun typecheck` pass (lint reports existing warnings).
- Focused server, migration, Bridge, queue, projection and bootstrap coverage: 255 tests pass.
- Real WebSocket scheduled submission and restart coverage: 2 tests pass, covering project-root and fresh-worktree execution, persisted origin, one consumed budget, and one thread/send after replay.
- Shared cron/slash-command coverage: 34 tests pass. Composer/queue web regressions: 81 tests pass.
- Scheduler timing/recovery tests use Effect TestClock, an independent wall/monotonic clock, drain barriers and no real sleeps. Coverage includes forward/backward jumps, startup and running-loop transient failures, interrupted settlement, late recovery events, canceled queued delivery, capacity wakeup, one-run budgets, reserved-command replay and expired-task disablement.

`bun run test:full` was attempted and stops before the exhaustive Git matrix at existing upstream-ledger process-identity failures (`ps` is denied with `EPERM`). A separate full server-unit run reports 4,842 passing tests and 23 failures in process inspection, editor discovery, storage/backup helpers and backup HTTP operations. The additional storage and representative backup/HTTP failures were reproduced on untouched `main`; prior baseline checks reproduced the process, editor and helper failures. No tests or ledger code were changed to bypass them.

The user explicitly authorized reproduced baseline failures as an exception to the green phase-commit requirement. That exception applies only to verified baseline failures; feature regressions must still be repaired. All three phases are delivered as separate commits.

Phase 2 verification: the production web build passes its bundle budget; browser dialog/model/ordinary-notification tests pass (15 tests), server NL and outbox tests pass, and the desktop channel tests pass (21 tests). Workspace tests retain the explicitly allowed baseline process-identity failure. Phase 2 also adds the missing public origin type alias from Phase 1 and exposes associated turn IDs through a filtered run-history lookup for precise notification suppression.

Phase 3 verification: 234 focused scheduler/Bridge/queue/orchestration tests pass, including real local MCP grant/create/run/revoke, immutable continuation settings, native user-input attention, and final-send fencing. The complete web unit suite passes 2,276 tests; focused browser settings/dialog tests pass five tests. The exhaustive real-Git matrix passes 142 tests independently of the baseline-blocked root suite. Full server unit coverage reports 4,842 passes and the same 23 baseline failures. Final formatting, lint, workspace typecheck, server build and web production build pass (the web bundle remains 40.2% below its baseline).

Phase 3 also fixes earlier-phase lifecycle cases: completed turns retain unresolved input attention; user answers are durably associated and preserve execution settings and budget; known not-sent delivery failures settle after fencing; archived-thread failures retain their reason; metadata-only edits remain possible for expired one-shots.

## Schedule editor defaults

New tasks default to the project root and the daily preset. The workspace menu lists the project root first; worktree isolation remains an explicit option. Existing tasks retain their saved workspace and cron.

The dialog offers Preset and Cron. The cron editor uses the shared evaluator for live descriptions and field-specific validation, inside one compact expression box, with sections navigable by Tab and a copy action. Pasting a full expression into any field distributes it across the editor. Expressions are bounded to 512 characters in both the input and shared validation; lists, ranges, steps, named months/weekdays and nth weekdays remain supported. The dialog keeps a fixed viewport-bounded height, and the description below the cron retains its last result while the next calculation is pending. Saving remains fenced by the current inputs. Descriptions and the next fire update automatically after edits; the Next link expands the five upcoming fires. Field ranges are available on hover, with no visible tutorial or example buttons. There is no preview button. Saving requires a matching valid calculation of the normalized expression, timezone and next fires. The natural-language option is removed from the dialog; existing one-shot tasks remain editable.

## Manual acceptance checklist

- [ ] Create a task from the daily preset; verify Project root is selected first and by default.
- [ ] Try the compact Cron editor, Tab navigation, full-expression paste, invalid ranges and automatic next-fire updates; edit an existing one-shot.
- [ ] Run at the project root and explicitly in a fresh worktree; test project/provider skills and missing-skill warnings.
- [ ] Respond to approval/input attention and observe settlement.
- [ ] Restart across multiple fires; verify one catch-up, overlap/pending coalescing and capacity recovery.
- [ ] Disable queued work and verify no send; resolve ambiguous delivery without resending.
- [ ] Click desktop notifications with no renderer open and test browser fallback.
- [ ] Activate local MCP, grant scheduling, create/manage a supervised task, reject unsafe mode, revoke authority.

History retains terminal runs for 90 days with a 1,000-row per-task cap, delivered notifications for seven days, and undelivered terminal notifications for 30 days. Unfinished execution and unresolved evidence are retained. Deletion preserves existing threads/worktrees. Native notification delivery is bounded at-least-once; a crash between presentation and acknowledgement can repeat a notice.

## Review follow-up scope

The local Agent Bridge listener restoration is an explicit part of Phase 3, including the existing read, thread and task MCP toolsets. It stays opt-in, loopback-only, and requires fresh UI activation; existing credentials receive no automatic scheduling grant. Scheduler mutations now apply only to the calling agent client's own supervised tasks. User-owned schedules remain read-only to agents. The unrelated task-board UI remains shelved.

Sidebar grouping and explicit read/unread receipt persistence were requested during feature testing. Read-state writes occur for explicit user acknowledgements (including bulk acknowledgement), rather than every streamed message. The existing Bridge branch helper's detached-HEAD default-branch fallback is also part of this PR and is called out for owner review.

## Comparison with T3 Code

T3 Code has its own scheduled tasks: `ScheduledTaskService.ts`, `scheduling/Scheduler.ts` and webhook modules on the server, `packages/contracts/src/scheduledTask.ts`, a `/settings/scheduled-tasks` page with project-scoped views, a per-thread `ThreadAutomationsPanel.tsx`, and the MCP tools `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task` and `run_scheduled_task_now`. f5's scheduler was designed separately and keeps its own engine and schedule semantics. Only management and targeting features where T3 Code is ahead are adopted.

| Capability                  | T3 Code                                                | f5                                                                                          | Decision                                                             |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Schedules                   | Interval, fixed time + weekdays, webhook               | Cron + IANA timezone, presets, one-shot, `maxRuns`                                          | Adopt a fixed-time + weekday editor                                  |
| Missed fires                | Fixed-time fires more than 10 minutes late are skipped | One coalescing catch-up                                                                     | Keep f5; a catch-up age limit is deferred                            |
| Run completion              | Marked successful when launched or queued              | Durable runs that follow turn completion, attention, recovery, quarantine and notifications | Keep f5                                                              |
| Agent control               | Single upsert with partial updates                     | Six tools, `f5.schedules` grant, `expectedVersion`                                          | Adopt partial updates                                                |
| Management scoping          | Project-scoped views                                   | One list                                                                                    | Adopt a project filter                                               |
| Run into an existing thread | Yes                                                    | Every run creates a thread                                                                  | Adopt with idle-only admission                                       |
| Per-thread automations UI   | Yes                                                    | No                                                                                          | Adopt                                                                |
| Interaction mode per task   | Yes                                                    | No (`/plan` rejected)                                                                       | Adopt                                                                |
| List order                  | Creation time                                          | Last update                                                                                 | Adopt                                                                |
| Timezone label              | Server timezone label, later reverted                  | Per-task IANA timezone                                                                      | Equivalent; the editor labels the task timezone                      |
| Webhooks, intervals         | Yes                                                    | No                                                                                          | Not ported (`relay-cloud`, `upstream-only:scheduled-task-intervals`) |

### Thread-bound tasks

A task with the `thread` workspace sends each run into one existing conversation. A run is claimed only while that conversation is idle: no active or running turn, an empty queue, no pending approval or input, no provider send in flight, and no other bound run claimed but not yet started. Until then it stays pending without capacity with reason `conversation_busy`. Manual fires coalesce into it; the next scheduled fire replaces it, settling the waiting run as skipped with `conversation_busy` (which notifies), so a conversation that stays busy misses occurrences instead of carrying one forward indefinitely. At claim the run captures the conversation's live model, runtime and interaction mode into its immediate `queue-tail` command; that command is the only source of admitted settings for the delivery gate. If the scheduler is disabled or the conversation's model, mode or access changes before delivery, the bound item is canceled and only that queue item is soft-deleted, so the user's own queued messages are kept. The queue gate runs only for bound items and usage-limit resumes; unbound scheduled items keep the delivery worker's gate. If the delivery worker finds the run fenced after it claimed the delivery (canceled, revoked, or the conversation's settings changed), the delivery is abandoned as not sent and only that submission is retired: the queue is never paused, no provider failure is recorded, and the run settles as skipped with `canceled`, which does not notify. The queue dispatches a bound turn with `requireCurrentSettings`, so the decider rejects it at acceptance, rather than restoring its settings, when they changed after the send gate. The conversation's activity row reads "Queued by scheduled task", because admission only queues the message; the run's history shows whether it was later canceled. Bound runs never use scheduled continuations: interrupted, usage-limited and failed turns settle terminally, including a usage-limit rejection before any turn exists. Automatic restart and usage-limit recovery of a bound scheduled turn is refused, so it can never outlive a cancellation or a revoked grant; only the user's own answer in the conversation continues, as ordinary work. Archiving or deleting the conversation disables (never deletes) the tasks that still target it with `thread_unavailable` and cancels their unstarted runs, including one waiting as `conversation_busy`; a task retargeted since a run was created is left alone.

An agent can bind a task to a conversation only with the `f5.turns` grant that `send_message` requires, in addition to `f5.schedules`. The same check runs at save, at claim, before submission, at delivery and when authorities are revalidated, so removing either grant stops later runs. A bound task always uses its conversation's provider, model, options and mode, so agent input for those fields is rejected rather than silently replaced.

Known race: the idle check runs before the reservation transaction. If the user starts a turn in between, the bound item waits behind it at the queue tail while holding its capacity slot, and a reservation replayed after restart skips the idle check. The wait is bounded by the user's turn and counts against `maxConcurrentRuns`; it never sends ahead of the user.

An owning bound run blocks storage purge of its conversation, like any owning run. Migration 142 removes the unique `scheduled_task_runs.thread_id` constraint so runs can share a conversation. Builds that include it are not downgrade-safe for bound tasks: older builds cannot decode the `thread` workspace and quarantine those tasks. Unbound tasks are unaffected.

Fixed-time schedules and project scoping originate in upstream #2829 and were reorganized in #20842; f5's editor and filter are independent implementations of the same behavior. Upstream #18653 added a server-timezone label and #22230 reverted it, so f5 keeps per-task timezones. Webhook triggers, elapsed-time intervals and a catch-up age limit are deferred. Port decisions and their status live in the upstream tracking data (`upstream/topics`, `upstream/archive`) and on F5's Upstream page; they are not duplicated here.
