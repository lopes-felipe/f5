# Codex

This guide is for people who want to use more than one Codex account in T3 Code.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same T3/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In T3 Code Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In T3 Code Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

On Windows, keep the shared and shadow homes on the same drive. F5 uses junctions for shared
directories and hard links for shared files so shadow homes work without Developer Mode or an
elevated process. Windows cannot hard-link files across drives; in that case F5 copies the file and
logs a warning. The copy cannot reflect changes during a running session, but F5 refreshes its
managed copy the next time it materializes that shadow home.

## Which Account Am I Using?

Open Settings and look at the provider row.

T3 Code shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, T3 Code treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.

### Isolated profiles

[Profiles](../profiles.md) provide independent managed Codex homes and in-app login for work and personal accounts. Managed profiles require Codex 0.144.3 or newer and file-backed credentials. Versions older than the audited 0.162.0 baseline show a notice that newer protocol features may be missing; newer versions show an informational notice. Legacy Default shadow-home behavior is unchanged.

## Disk space from Codex marketplace upgrades

When a Codex home has a Git-sourced plugin marketplace configured, each `codex app-server`
start clones the whole marketplace into `.tmp/marketplaces/.staging/marketplace-upgrade-*`
and then swaps it in. If the process stops before the swap, Codex never removes the clone.
These clones can be hundreds of MB each.

F5 limits this in three ways:

- Session-note, compaction and harness-validation prompts share one warm app-server per
  Codex launch config instead of starting one per prompt. The warm process stops after
  5 minutes idle, after 50 prompts, or after any failed prompt. It is not tied to the
  signed-in account: after `codex login` switches accounts in the same home, background
  prompts can use the previous login until the warm process stops.
- These one-off app-servers, and the `codex exec` runs that generate titles, commit messages,
  PR text and branch names, start with `-c features.plugins=false`, so they never begin a
  marketplace upgrade. Thread sessions keep plugins on.
- Every hour, F5 deletes `marketplace-upgrade-*` dirs older than 2 hours in every Codex home
  it launches, even when automatic storage cleanup is off. It deletes a
  `marketplace-backup-*` dir only when an installed marketplace from the same source sits
  next to it; a backup Codex kept after a failed rollback may be the only copy and is left
  alone. Each deletion is recorded in the automatic cleanup history. **Settings → Storage →
  Provider homes** offers the same cleanup on demand.

## Release 0 rewind compatibility

F5 resolves the retained history boundary once, then tries `thread/revert`, legacy
`thread/rollback`, and finally a boundary-limited `thread/fork`. Unknown-method support
is cached per process. The exact paginated-history error is cached per native thread,
so rewinding a legacy thread does not disable revert for its adopted fork.

Fork fallback uses the experimental API, validates paged retained turn IDs before
adoption, and persists the new cursor before its final read. Early fork events are
buffered and routed to the original F5 thread after validation. A lost fork response
blocks further rewind in that process and logs a possible orphan instead of retrying
blindly. The old native thread is unsubscribed best-effort. Recovery checks the stored
source thread ID as well as the retained boundary. Active turns must be interrupted
before conversation rewind; the orchestration command already rejects active turns.

The generated experimental **0.160.1** request types certify F5's actual initialize,
thread/start, thread/resume, thread/fork, thread/revert, turn/start and turn/steer builders.
Run `bun run protocol:audit:requests:baseline`. Selected schema checksums are recorded in
`scripts/fixtures/codex-requests/baseline.json`. Source revision
`d27764b82f7118f674371e6d6e76271d9d606edb` emits the pinned legacy-history error.
The 0.156.0 protocol source at `fe74a774532af67b5a4a3dec03ce9469e17f89af`
has no thread/rollback method and gates fork.beforeTurnId experimentally. The generated
0.156.0 experimental schemas also confirm both fork.beforeTurnId and excludeTurns;
checksums are in `scripts/fixtures/codex-requests/legacy-0.156.0.json`. These facts
were checked against the official repository, not inferred from CLI version alone.
The [0.147.0 request declaration](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
marks rollback deprecated. The [0.158.0 start implementation](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/src/request_processors/thread_processor.rs)
defaults persistent threads to paginated history when the thread store supports history lists
(source revision `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`).

Release 1 moved the full protocol manifest to **0.160.1** (see below). The minimum
permitted CLI remains 0.37.0; versions below 0.144 are permitted but unverified. Custom executable paths and CODEX_HOME isolation are preserved;
certification installs use temporary directories and never replace the operator CLI.

For a credential-free native startup smoke, set `CODEX_BINARY_PATH` to the chosen
executable and run `bun scripts/certify-codex-runtime.ts`. It uses a temporary CODEX_HOME
and checks initialize, start and unsubscribe. Empty threads have no rollout yet, so
read, fork and resume require a first authenticated model turn.

For model-backed certification, run `bun apps/server/scripts/certify-codex-rewind.ts` with
`F5_CODEX_LIVE_TEST=1`, `CODEX_BINARY_PATH`, and `F5_CODEX_CERTIFICATION_HOME` (or
`CODEX_HOME`) pointing to an authenticated profile. It copies only auth/config into a
private temporary home, creates two trivial turns, rewinds one, validates retained IDs,
and completes a follow-up. `F5_CODEX_RESUME_BINARY` switches executables after the seed
turns, allowing a 0.147 thread to exercise the 0.156 legacy-history fork. Model selection
uses the seed runtime's native catalog default; `F5_CODEX_CERTIFICATION_MODEL` overrides it.
This matters: the account rejected gpt-5.4 on 0.160.1 and gpt-6.1-sol on 0.147, while the
catalog defaults below succeeded.

Release 0 authenticated checks on **macOS arm64**, 2026-10-07:

| Runtime | History              | Successful rewind path                          | Model       | Retained IDs and follow-up |
| ------- | -------------------- | ----------------------------------------------- | ----------- | -------------------------- |
| 0.144.3 | new legacy thread    | revert rejected → rollback                      | gpt-5.6-sol | passed                     |
| 0.147.0 | new legacy thread    | legacy revert rejected → rollback               | gpt-5.6-sol | passed                     |
| 0.156.0 | resumed 0.147 thread | legacy revert rejected → rollback absent → fork | gpt-5.6-sol | passed                     |
| 0.160.1 | new paginated thread | revert                                          | gpt-6.1-sol | passed                     |

Native startup/unsubscribe also passed on all four isolated executables. The automated
fake-server matrix covers exact fork requests, retained-history mismatch, lost responses,
early events, cached flags and failed post-adoption reads. Provider-directory and
orchestration recovery tests prove the validated fork cursor survives final-read failure.
Manual browser UI acceptance and Linux/Windows release-environment runs remain unverified;
the model-backed matrix above exercises the actual manager, not a fake server.

## Release 1 protocol baseline (0.160.1)

`bun run protocol:audit:baseline` installs Codex 0.160.1 into a temporary directory and
audits two layers:

1. **Surface.** Every server notification, server request and thread item in the
   generated experimental TypeScript must have a disposition in
   `packages/shared/src/codexProtocolManifest.ts`, and every client request group F5
   sends must have at least one method the CLI offers.
2. **Fields.** For responses F5 decodes, `CODEX_DECODED_RESPONSE_FIELDS` lists the exact
   fields it reads; each is resolved through the generated JSON schema
   (`generate-json-schema --experimental`, following `$ref`, `allOf`, `anyOf`, `oneOf`
   and array items). Request shapes are certified separately by
   `bun run protocol:audit:requests:baseline`, which type-checks F5's real builders.

Checksums of the surface files and decoded response schemas are committed in
`scripts/fixtures/codex-protocol/0.160.1.json` with the CLI version and source revision
`d27764b82f7118f674371e6d6e76271d9d606edb`. Any regenerated difference fails the audit;
after re-certifying, refresh it with `CODEX_SOURCE_REVISION=<commit> bun scripts/audit-codex-protocol.ts --install-baseline --write-fixture`.

Dispositions added for 0.160.1:

| Surface                                                                                                                                                                                                                   | Disposition        | Why                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/reverted`                                                                                                                                                                                                         | state-only         | F5 validates retained history through its own paged read-back; the adapter has no second handler.                                                                 |
| `rawResponseItem/completed`                                                                                                                                                                                               | internal-duplicate | Raw items duplicate the typed `item/*` stream (`experimentalRawEvents:false`).                                                                                    |
| `rawResponse/completed`                                                                                                                                                                                                   | internal-duplicate | Internal per-completion usage; `thread/tokenUsage/updated` already carries the usage F5 records.                                                                  |
| `functionCallOutput` item                                                                                                                                                                                                 | internal-duplicate | Duplicates the typed tool items F5 renders; dropped silently.                                                                                                     |
| `item/fileChange/outputDelta`                                                                                                                                                                                             | diagnostics-only   | No longer emitted; the adapter still maps it for persisted logs and older CLIs.                                                                                   |
| `thread/compacted`                                                                                                                                                                                                        | canonical          | Deprecated in favor of the `contextCompaction` item, but older CLIs only send this.                                                                               |
| `thread/attachment/updated`, `thread/queue/changed`, `project/changed`, `thread/project/updated`, `thread/environment/*`, `account/gatewayOAuth/changed`, `mcpServer/event/stream/notification`, `thread/realtime/item/*` | state-only         | Native attachments, queues, projects, environments, gateway OAuth, MCP streams and realtime voice are not mapped; queue and projects would create a second owner. |
| `modelProvider/authRecovery{Started,Completed}`, `autoApprovalReview/strictReviewRequired`                                                                                                                                | diagnostics-only   | Visible in native logs only.                                                                                                                                      |

No surface present in 0.144.3 was removed in 0.160.1, so no manifest entry was dropped.
Runtime handlers for older CLIs (for example `currentTime/read`, `thread/rollback`) stay.

Field-level findings:

- All 34 decoded response fields exist in 0.160.1 and in 0.144.3. On 0.144.3 and 0.147
  `thread/revert` is absent, so its response is skipped and the rollback fallback is used.
- `model/list` exposes no context-window metadata in 0.160.1; F5 falls back to its built-in
  context windows. `additionalSpeedTiers` is not read.
- F5 sends no `personality` or multi-agent fields; `collaborationMode` remains current,
  so no request field needed removal.
- `capabilities.mcpServerOpenaiFormElicitation:false` is still sent. 0.160.1 marks it the
  legacy opt-in for `openai/form`; the replacement is `capabilities.extensions`. F5 switches
  only after the private elicitation path (Release 3) passes end-to-end and the minimum
  supported CLI passes 0.147.

Older CLIs: the manager, adapter and rewind suites pass against fakes, and the
credential-free startup smoke (`bun scripts/certify-codex-runtime.ts`) passed on 0.144.3
and 0.160.1 on 2026-10-07. The authenticated rewind matrix from Release 0 above covers
0.144.3, 0.147.0, 0.156.0 and 0.160.1. CLIs older than 0.144 are permitted but unverified.

## Release 2: models, catalogs and inventory

### Reported models

Once per instance and CLI version, F5 opens a short-lived control client and pages
`model/list`. The probe has an 8-second budget, and the process is closed in `finally`.
Hidden models are dropped. Efforts come from `supportedReasoningEfforts` and
`defaultReasoningEffort`, tiers from `serviceTiers` and `defaultServiceTier`, and
`upgrade` becomes an advisory. `additionalSpeedTiers` is never read. Fast mode is offered
only when a `fast` tier is reported. A model that reports no efforts gets no effort
control. Reported capabilities override same-slug built-ins. If the probe fails, the last
good result or the built-ins stay in use, and no slug a persisted thread uses is dropped.
A failed probe is not retried for the same CLI version for 30 minutes. Concurrent
callers share a single probe.

Each session also reads its own `model/list`. `turn/start` resolves the requested effort
against that list, walking down to the nearest offered level, so a CLI-only model
receives the effort the composer showed. A `fast` service tier is sent only when the
session's list offers it. The composer applies the same rule to effort and fast mode
before it dispatches.

### Catalogs

The same probe reads `skills/list` for the instance. `repo` skills are excluded there,
because the project scan owns repository files. The instance's `user`, `system` and
`admin` skills form its private catalog, and switching instance in the composer drops
it.

### Inventory (read-only)

Settings → Providers → an instance → **Hooks, plugins and connectors** opens a control
client with the instance's own `CODEX_HOME` and reads:

- `hooks/list`: program name only
- `plugin/list`: installed plugins, local marketplaces only, no remote refetch
- `app/list`
- `config/read` with layers, for configured MCP servers

F5 launches every app-server with `-c mcp_servers={}`, so `mcpServerStatus/list` would
always be empty. MCP servers are read from each config layer's `mcp_servers` table
instead, with the name and transport only, never commands, URLs or environment. The
`sessionFlags` layer is skipped because it holds F5's own override. A server is shown as
disabled when `enabled = false` or when its layer has a `disabledReason`.

Sources come from the hook source or the MCP server's config layer:

| Codex source                                    | Shown as |
| ----------------------------------------------- | -------- |
| user, sessionFlags                              | instance |
| project                                         | project  |
| system, mdm, enterpriseManaged, cloud*, legacy* | managed  |
| plugin                                          | plugin   |

If a method is unsupported, it becomes a warning instead of failing the view. F5 never
installs, removes or edits these.

`hooks/list`, `plugin/list` and `app/list` were added to `CODEX_CLIENT_REQUEST_METHODS`.
Their decoded fields, plus the new `model/list` and `skills/list` fields, are certified
against 0.160.1 (66 fields). The fixture was refreshed for the three new response
schemas.

## Release 3: MCP, elicitation, questions and approvals

### Command approvals

F5 reads `availableDecisions` and `proposedExecpolicyAmendment` from
`item/commandExecution/requestApproval`. When an amendment is offered, the prompt shows
**Always allow `<prefix>`** with a warning that it applies to future commands that start
the same way. The choice is sent as `acceptWithExecpolicyAmendment` with the stored
prefix, and only when that request offered it. A decision the request did not offer is
refused. If the list holds no refusal F5 recognizes, **Decline** and **Cancel turn** are
offered anyway, so a request can always be refused. Network amendments are not
supported.

### Non-blocking questions

`request_user_input` with `isBlocking: false` stays visible after the turn ends. It does
not hold the composer, the attended watchdog, restart continuation or usage-limit
resume. It is dropped when the session ends.

### MCP elicitation

Form and URL requests from `mcpServer/elicitation/request` open a form in the composer.
Answers go through the private `elicitation.submit` RPC described in
[claude.md](./claude.md#mcp-elicitation), never through the event-sourced answer
command. `serverRequest/resolved` and `turn/completed` settle the request: **resolved**
for an accepted answer, **cancelled** for a decline or cancel. A request opened outside a
turn stays pending until it is answered or the session stops. Stopping the session marks
an answered but unconfirmed request as indeterminate. Unattended read-only workflow
stages cancel form requests, for Codex and ACP providers alike. ACP providers (Grok,
Antigravity) answer in-process, so their forms settle as soon as the answer is delivered,
as Claude's do.

Codex also uses `mcpServer/elicitation/request` to ask before an MCP tool call. Those
requests have an empty schema and `_meta.codex_approval_kind` (for example
`mcp_tool_call`). They go to the approval UI with **Approve once**, **Always allow this
session** and **Always allow**, as advertised in `_meta.persist`, not to the private
form path.

Live check, codex-cli 0.160.1, 2026-10-09, in approval-required mode: the tool-call
consent arrived as an approval. The tool's form then arrived through the private path,
with only the value-free descriptor in F5's events. The answer was delivered,
`serverRequest/resolved` produced a **resolved** receipt, and the tool received the
values. In full-access mode, Codex declines elicitations itself and never sends them
to F5, so MCP forms only appear in modes that ask for approval.

The OpenAI form extension (`mcpServerOpenaiFormElicitation`) is still not advertised,
because no live `openai/form` request has been exercised. codex-cli 0.147.0 could not
be checked live: this account's current models all require a newer CLI.

### MCP reload

Every app-server is launched with F5's MCP servers pinned by `-c mcp_servers=...`, so
`config/mcpServer/reload` cannot change that set. When the stored config differs from
the set the session launched with, the reload reports **restart required**. The
session's config version stays stale, so the session restarts at its next turn with the
resume cursor kept. A running turn is never interrupted. Otherwise F5 reloads and reads
`mcpServerStatus/list`. 0.160.1 lists servers without `startupStatus`, so a server that
reports tools counts as connected. Failures are retried up to three times with backoff
(0.5 s, 1.5 s, 4 s), then shown as a thread warning and under
**Apply to live sessions**. The config version advances once the reload reached the
session, even if a server still fails, since restarting would not fix it; the session is
marked unconverged instead. **Apply** reloads sessions whose version is out of date or
whose last reload did not converge, four at a time, so clicking it again after fixing a
server retries it.

After an MCP login, F5 reloads the project's sessions with its own retries (no per-session
backoff). Each retry reloads only the sessions that still failed, and their warning is
posted after the last attempt. A session that needs a restart is not a failed reload: its
warning is posted at once, it restarts at its next turn, and the login reports success.

Wire protocol 18 adds elicitation descriptors and receipts, the `elicitation.submit`
RPC, approval presentation fields, non-blocking questions and the structured MCP apply
result. Clients and servers must both run Release 3.

## Release 4: native operations

Release 4 uses wire protocol **19**, the increment after this repository's Release 3
protocol 18. Native actions require a session capability. Compaction is separately
certified on
codex-cli **0.159.2 and later**; review, goals, attachments and user forks require
**0.162.0**. Older executable paths retain F5 summaries and conversation rewind.
F5 continues owning queues, projects and worktree history.

The shared durable operation coordinator persists admission, dispatch, native
identity and outcomes. Direct/queued turn delivery waits while native work owns the
thread. Generation checks fence results from replaced sessions. Lost responses,
timeouts and shutdown keep an indeterminate reservation until provider read-back
establishes settlement; they never dispatch a replacement operation automatically.
F5 application receipts are separate from native completion, so a crash between the
two cannot silently repeat a fork or file mutation.

The runtime panel presents requested versus effective configuration, fallback and
retry notices, outcomes, child output, native receipts, attachments and goals without
changing the meaning of cost or cumulative usage. F5 renames call `thread/name/set`
with a loop guard. Unsupported methods and rename failures do not fail the thread.

### Compaction, review and forks

Whole-conversation native compaction uses `thread/compact/start`, requiring a
correlated `contextCompaction` item and completed native turn. Partial ranges and
pivots retain F5's summary path. A native compaction record is never a prior-work
summary; lost-cursor recovery generates an F5 summary before a fresh session.

Compaction is certified separately from the other native operations and is enabled
on CLI **0.159.2 and later**. On 2026-10-10, authenticated checks on 0.159.2 and
0.160.0 verified a correlated `contextCompaction` receipt, persisted history, and
access to a token in a retained user message through two stop/resume cycles. This
checks conversation continuity; it does not prove the generated summary retained
information that native compaction discarded. Older or unknown
versions retain F5's summary path. Review, goals, attachments and user forks keep
their 0.162.0 certification gate.

Repeat the isolated acceptance test with
`CODEX_BINARY_PATH=/path/to/codex CODEX_HOME=/path/to/profile bun run --cwd apps/server test:codex:compaction:live`.
It copies account credentials into a temporary home, creates a new thread in a
temporary workspace, and never compacts an existing user thread. Its output contains
outcomes only. No CLI installation or configured executable is changed.

`/review` defaults to uncommitted changes. `/review <branch>` and `/review <commit>`
select a base branch or commit; the runtime panel exposes the same targets. Review
uses inline delivery, existing approvals and usage events, and the shared operation
reservation. Auxiliary review events arriving before the response are buffered with
bounds and routed to the F5 thread. Review completion is anchored to the returned
review turn ID, rather than an unrelated control-turn lifecycle ID.

“Fork from here” creates a new F5 thread and configured worktree. Native history is
validated against the selected boundary before adoption. The source thread and its
workspace are untouched, and the target receives a distinct resume cursor. Child
thread inspection uses `thread/items/list` pages and persisted child identities;
it does not expose the manager's full-history accumulator as pagination.

### Goals and Stop

Goal operations use `thread/goal/set`, `get` and `clear`. The operation reservation
owns all continuations until the goal settles, preventing races with F5 queues or
workflow stages. The goal's objective and state appear in the thread header. F5's
token budget is authoritative: observed exhaustion pauses the native goal. Stop
pauses it before interrupting the current native turn; a failed pause closes the
provider process rather than allowing uncontrolled continuations. Resume and fork
requests defer goal continuation. Reconciliation pauses an active goal with no live
F5 owner and waits for any running turn before releasing the reservation.

### Attachments

Native `thread/attachment/updated` is canonical metadata: attachment IDs, type,
identity key and operation. The UI labels these entries **From Codex**. Events do not
contain file bytes. The audited attachment API stores extension metadata; it is not
an upload endpoint for arbitrary model inputs. User images/files therefore continue
through F5's existing attachment path exactly once, with no duplicate native upload.

### Live spike: codex-cli 0.160.1, 2026-10-09

`apps/server/scripts/spike-release4-codex.ts` runs an authenticated app-server in a
temporary isolated home and Git workspace, and removes its temporary state on exit.
It confirmed:

- Forks with and without `beforeTurnId` are accepted; the source history remains.
- Attachment add/list/update works for metadata, establishing the upload distinction
  above.
- Setting an active goal automatically starts continuations. A 100-token budget
  reaches its terminal budget state; the manager's F5 guard pauses it and waits for
  the native turn. Goal-updated and goal-cleared notifications were observed.
- Compaction retains prior turns and appends a native turn containing a
  `contextCompaction` item. Settlement came through `turn/completed`; this runtime
  did not emit the older `thread/compacted` notification.
- Inline review completed and emitted entered/exited review items. Its response and
  items used one review turn ID while a later `turn/started` used another control
  ID. The implementation anchors completion to the response and normalizes the
  control lifecycle ID; a regression test reproduces the ordering. The corrected
  manager completed the authenticated spike successfully.

The fixed-version protocol and request-builder audits pass on 0.160.1. These native
feature spikes do not replace the older-version rewind matrix or platform-specific
release lifecycle tests.

### Release 4 version bump: codex-cli 0.162.0

The current protocol baseline is **0.162.0**, source commit
`c1382380de69521303b416720a52f42d51af6248`. The historical 0.160.1 fixture remains
available. The refreshed inventory has 86 notifications, 11 server requests and 19
item discriminators; all 66 decoded response fields and all seven real request
builders pass the generated experimental schema audits. The added
`thread/prediction/updated` notification is state-only: F5 does not enable native
predictions as a second prompt producer.

The authenticated 0.162.0 Release 4 spike passed forks, attachment metadata,
goal continuation/budget pause, native compaction and inline review. New-history
rewind used `thread/revert`, preserved the expected history, and completed a follow-up
model turn. The compatibility matrix was also rerun on 0.144.3 and 0.147.0
(rollback) and a 0.147.0 thread resumed on 0.156.0 (validated fork); retained turn
IDs and follow-up model turns passed on all three. The live-spike script initializes
its isolated home once and fails if
any required request or completion does not succeed.

Codex remains an external executable. Updating F5 or this baseline does not replace
an operator's installation or custom executable path. For an npm installation,
`npm install -g @openai/codex@0.162.0` installs the pinned certified version; verify
`codex --version`, or select the upgraded executable in Settings > Providers & Models.
Compaction requires 0.159.2; the other native capability gates require the certified 0.162.0 runtime. Older CLIs retain their existing conversation and rewind paths. `deferGoalContinuation` is omitted from resume requests below 0.162.0.

### Review targets and recovery

`/review` reviews uncommitted changes. `/review branch:<name>` selects a base branch;
`/review commit:<sha>` selects a 7–40 character commit SHA. A bare argument always
means a branch, including hexadecimal names such as `deadbeef`. The runtime panel
uses the same parser.

Review, goal and fork requests return a durable admission receipt promptly; the
runtime panel follows completion separately. Goals hold the thread reservation,
not an account lease for their whole lifetime. Operation polling is read-only and
never resumes a stopped provider. Reconciliation checks are bounded and skip live
waiters. Lost fork responses without a known fork identity remain uncertain; absence
of an ID does not prove that the provider created nothing. Fork reconciliation
validates the persisted retained turn IDs before reporting provider completion.

**Stop provider and acknowledge** releases an uncertain reservation without repeating
the mutation. Inspect files, conversation and any preserved fork workspace first.
Fork workspaces start at the source branch tip, and their paths remain in operation
records after failure; F5 does not delete those worktrees or branches automatically.

Native review and compaction waiters follow correlated settlement, provider exit or
explicit interruption rather than a fixed two-minute deadline. Long healthy turns
remain running and retain admission. A goal holds the same exclusive reservation;
interrupt the conversation turn to pause a running goal, then use Clear settled goal.
Pause/clear commands are not admitted alongside another native operation.

Recovery of a missing native-compacted rollout marks the replacement cursor's context
as pending. Its recovered summary is delivered in the first `turn/start` developer
instructions even when the replacement thread is resumed, and the marker is cleared
only after that request succeeds.
