# Claude

This guide is for people who want to use more than one Claude setup in T3 Code.

Common reasons:

- use separate work and personal Claude accounts
- try a different Claude Code configuration without disturbing your main setup
- run Claude through a router such as Claude Code Router
- use external providers exposed through a Claude-compatible workflow

## I Only Use One Claude Account

Use the default provider.

Log in with Claude Code normally:

```bash
claude auth login
```

In T3 Code Settings, your Claude provider can stay like this:

```text
Display name: Claude
Binary path: claude
Claude HOME path: empty
```

The default `claude` binary setting selects the executable bundled with the Claude Agent SDK; it
does not require a global `claude` command on `PATH`. An empty `Claude HOME path` means T3 Code uses
your normal home directory.

F5 pins Claude Agent SDK 0.3.292, which bundles Claude Code v2.1.292. Claude Fable 5.1
requires v2.1.257+ and provides native 1M context. Opus 5.5 requires v2.1.280+, provides native 1M context, and is now the default Claude model
with `medium` effort.
F5 sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and defaults `CLAUDE_CODE_ENABLE_TASKS=0`
to expose the legacy `TodoWrite` surface required by its assistant instructions. Set
`CLAUDE_CODE_ENABLE_TASKS=1` in the server environment to opt into the newer task-tracking
surface instead; F5 preserves this explicit operator override. That surface replaces
`TodoWrite` with task-tracking tools.

With a custom executable, known versions below v2.1.257 omit Fable 5.1 and show an upgrade
advisory. Known versions below v2.1.280 also omit Opus 5.5 and show the upgrade advisory.
Bare `opus` and `claude-opus` resolve to Opus 5.5; explicit `opus-5` stays on Opus 5.
Unknown versions remain permissive. Bare `fable` and `claude-fable` aliases now
resolve to Fable 5.1; explicit `fable-5` stays on Fable 5. Unavailable picker selections
fall back to a supported option. Persisted thread models and sub-agent overrides are forwarded
without silent substitution, so an older executable can reject them. Select a supported model
or upgrade the custom executable to recover.

### Turn cost accounting

F5 converts cumulative SDK costs into per-turn deltas. Fresh sessions start at zero. Resumed
queries can restore historical totals, and older custom CLIs do not all support the usage RPC.
F5 stores the last observed total in the resume cursor and restores it across restarts, including
model and effort changes, without requiring that RPC. Older cursors without a valid total still
leave the first positive resumed result unpriced while establishing a baseline. Zeroed crash
results do not reset the baseline and remain unpriced.

An explicit `conversation_reset` with trigger `clear` resets the cost baseline to zero,
matching the pinned SDK contract. A lower positive total is also treated as a reset for legacy CLIs that restart
cost totals on resume. This is a heuristic: if the first post-reset total equals or exceeds the
previous total, the delta under-counts spend by that previous total. An unexplained decrease is
also treated as a reset and charges the new total. Cumulative results alone cannot distinguish
these cases without an explicit reset signal.

Repair from a native log also leaves costs unreported because the cumulative total alone cannot
identify a turn's spend. Repair from a canonical completion retains the adapter's normalized cost.
These unpriced turns can make workflow budgets and usage totals lower than actual spend; they
are not recorded as zero-cost turns. Historical over-counted totals are not rewritten. Raw SDK
results, including cumulative costs and model usage, remain available in the native event log.

### Reproducing bundled-runtime release checks

Run `bun run --cwd apps/server test:claude:live` using Node 24.13.1+ on `PATH` and an
authenticated Claude account with Opus 5.5, Fable 5.1 and Opus 4.8 access. This opt-in suite consumes account quota;
ordinary test runs skip it. Authentication, quota, entitlement, timeout, and response-shape
failures fail the live run rather than being reported as passes or automatic skips.

The suite uses the bundled executable and the adapter's production query environment. It checks
account usage through `normalizeClaudeAccountUsage`, native 1M context, cancellation and child
process exit, streamed `TodoWrite` calls completing a three-step task, and structured `xhigh`
generation through the production generator and schema validator.

## I Want Work And Personal Claude Accounts

Use a different Claude home for each account.

Example:

```text
default home                 work account
~/.claude_personal_home       personal account
```

### Set Up The First Account

Log in normally:

```bash
claude auth login
```

In T3 Code Settings:

```text
Display name: Claude Work
Binary path: claude
Claude HOME path: empty
```

### Set Up The Second Account

Log in with a separate home:

```bash
mkdir -p ~/.claude_personal_home
HOME=~/.claude_personal_home claude auth login
```

Then add another Claude provider in T3 Code:

```text
Display name: Claude Personal
Binary path: claude
Claude HOME path: ~/.claude_personal_home
```

Use the email shown in Settings to confirm each provider is using the intended account. Emails are
blurred by default; click the blurred email to reveal it.

## Can I Switch Claude Accounts In An Existing Thread?

Usually, no.

T3 Code only offers Claude providers that use the same Claude home for an existing thread. A
different Claude home is treated as a different Claude environment.

This is different from the recommended Codex setup. Claude Code keeps account and local state across
multiple files under its home directory, so T3 Code keeps separate Claude homes isolated instead of
trying to share part of the state.

## I Want To Use OpenRouter

Use this when you want Claude Code to talk to OpenRouter directly, without running a local router.
This is the simplest external-provider setup.

OpenRouter provides a Claude Code integration through Claude's Anthropic-compatible environment
variables.

### Configure A Claude OpenRouter Provider

Add or edit a Claude provider in T3 Code Settings:

```text
Display name: Claude OpenRouter
Binary path: claude
Claude HOME path: ~/.claude_openrouter_home
```

In that provider's Environment variables section, add:

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

Mark `ANTHROPIC_AUTH_TOKEN` as sensitive. T3 Code stores the value as a server secret and does not
send it back to the app after saving.

If you want this setup isolated from your normal Claude account, create that home first:

```bash
mkdir -p ~/.claude_openrouter_home
```

If you previously used the same Claude home with a normal Anthropic login, run `/logout` in a Claude
Code session for that home before using OpenRouter. Otherwise Claude Code may keep using cached
Anthropic credentials instead of the OpenRouter token.

### Pick OpenRouter Models

OpenRouter can route Claude Code's default model roles to OpenRouter model IDs.

Example:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

Add those to the same provider's Environment variables section if you want stable model choices.

### Verify OpenRouter Is Being Used

Open a Claude session and run:

```text
/status
```

You should see the Anthropic base URL set to:

```text
https://openrouter.ai/api
```

You can also check the OpenRouter activity dashboard for requests from your API key.

### Common OpenRouter Mistakes

- Use `https://openrouter.ai/api`, not `https://openrouter.ai/api/v1`, for Claude Code.
- Set `ANTHROPIC_AUTH_TOKEN` to your OpenRouter API key.
- Set `ANTHROPIC_API_KEY` to an empty string so Claude Code does not try to use an Anthropic login.
- Put these variables on the Claude provider instance, not in global shell startup files.

OpenRouter's setup can change over time. Use its upstream Claude Code guide for the current details:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## I Want To Use Claude Code Router

Claude Code Router is useful when you want a local routing layer with more control than a direct
OpenRouter setup.

T3 Code does not need a special Claude Code Router provider. Treat the router as a Claude
environment.

Use this when you want Claude Code Router to decide which upstream model or provider handles Claude
requests.

High-level flow:

1. Start Claude Code Router.
2. Add or configure a Claude provider in T3 Code.
3. Put the router's required variables on that provider instance.

Configure a Claude provider:

```text
Display name: Claude Router
Binary path: claude
Claude HOME path: ~/.claude_router_home
```

Then copy the variables that `ccr activate` would export into the provider's Environment variables
section. Mark tokens and API keys as sensitive.

If you want the router-backed setup to stay separate from your normal Claude account, create and log
in with a dedicated home first:

```bash
mkdir -p ~/.claude_router_home
ccr start
ccr activate
HOME=~/.claude_router_home claude auth login
```

Claude Code Router's setup can change over time. Use its upstream README for the current install and
configuration steps: <https://github.com/musistudio/claude-code-router>.

## I Want Different Claude Settings, Not A Different Account

Create another Claude provider with the same account if you want a named preset.

Examples:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

If the preset needs different Claude files, give it a different `Claude HOME path`. If it needs
different API keys, base URLs, or router settings, use Environment variables.

Do not put environment variable assignments in `Launch arguments`.

## Account Usage and Limits

The Usage page shows one account card for each configured Claude instance, alongside F5 activity.
Account cards use the instance's server-default authentication context: its configured HOME and
environment, with the server working directory and user/project/local settings. A conversation's
project-specific overrides can select another authentication context and are outside these cards.

Account usage uses the installed Claude Agent SDK's experimental structured `/usage` control API.
Its method and response can change between SDK releases. Unsupported versions receive an explicit
unsupported state; an initialization, authentication, executable, or response failure is reported
separately. Raw provider errors and account payloads are not sent to the browser.

Opening Usage schedules stale account reads without blocking historical activity. Attempts are reused
for five minutes after completion, with at most two account probes running across all instances. Refresh updates
history and requests fresh account data; force refresh bypasses the five-minute cache after a
30-second minimum interval and coalesces with any queued or running job. Each probe has an eight-second
budget after acquiring a permit. Switching the history range or provider does not trigger account
reads. Focus and reconnect refresh stale account snapshots. While jobs run, the page polls in-memory
progress; it does not periodically launch external usage probes. Account snapshots live only in memory.
Disabling, removing, or replacing an instance cancels its account work.

Claude percentages are already percentages, including values above 100%. Missing utilization is shown
as Unknown. If plan limits are not reported, the card says so without inferring the authentication
cause. Extra usage shows enabled state and utilization only; monetary amounts are omitted because the
SDK does not establish their denomination. A failed refresh keeps the last successful data and its own
fetch timestamp visible. Updated labels use absolute local timestamps, so they remain accurate on
an idle page without periodic external reads. History loading or failures do not hide account cards.
Codex token history and quota snapshots share one account card and retain successes independently;
each Codex refresh owns a short-lived control client that closes on completion or cancellation.

F5 historical Claude tokens use reported main-agent usage fields. Whole-tree `modelUsage` fields do
not fill gaps in these token facts. As a result, some older or repaired events can have unreported
tokens. SDK-reported cost estimates can cover a broader scope and are not invoice data; an exact
cost-per-token or cache-ratio relationship should not be inferred. This feature neither rewrites
persisted facts nor changes cost accounting.

The structured usage operation can scan local transcripts; omitting those fields from the UI does
not avoid that work. On 2026-09-05, a prompt-free OAuth Pro read took approximately 1.1 seconds against
183 files (30 MB) under the local Claude projects history. A process inventory after completion showed
no additional Claude process. Larger histories still need representative latency checks if usage
refresh feels slow.

### Isolated profiles

Use [Profiles](../profiles.md) for independent managed Claude accounts and in-app login. Isolated profiles use the certified bundled executable and a complete home environment on Windows. The real-provider release gate includes macOS keychain separation.

## Host instructions

Release 0 sends F5's full host contract through the type-checked Claude Code preset
`systemPrompt.append`, with `snapshot: false`, on every start and resume. The previous
`appendSystemPrompt` option was ignored by the SDK. The append includes workflow policy,
project memory, preserved transcript and post-compaction prior-work context. Threads
compacted before this fix regain that context on their next restart. Instruction profiles
now identify Claude supplement `v11`. Turn counters are omitted from this append so normal
turns do not invalidate its prompt cache; date, model and effort update on relaunch.

Transcript injection is disabled by default pending the authenticated snapshot-replacement
spike: Claude returned **Not logged in** in the implementation environment. Operators
who have confirmed stale recorded prompts can opt into a one-time legacy-session update
with `F5_CLAUDE_LEGACY_HOST_CONTRACT_UPDATE=1`. It adds a delimited block to the first
ordinary message only for a cursor with no `hostContractVersion`; an acknowledged update
records a fixed migration marker, independent of future supplement bumps. The block says
that the current launch's system instructions supersede earlier transcript contracts.
Slash commands defer it. This writes permanently to the native transcript, so enable it
only after confirming the snapshot issue. Run `bun run --cwd apps/server test:claude:live`
to certify two resumes of a pre-existing session and native allow-rule policy enforcement.

Mandatory restrictions are enforced before native permission approval: one-off generation
has no tools; disabled sub-agents exclude Agent and the legacy Task delegation tool;
read-only workflows use a host PreToolUse denial hook. The same evaluator also guards
`canUseTool`. Permitting hook results do not grant approval, and project hooks remain
loaded. Workflow-policy changes go through session restart; incompatible direct sends
fail visibly. Human composer messages, steering and reliably attributed queued messages
carry SDK human origin. Automation and legacy queue entries remain unattributed. Native
reply UUIDs fence unrelated assistant/stream output and background results from human turns.
Unstamped native results use the carried reply ownership, origin and resume reason. Observed
unrelated costs advance the baseline without charging the human turn.

### Plan-mode instructions (Release 1)

Plan-mode guidance is no longer part of the append. Every launch passes it as the SDK's
`planModeInstructions`; Claude Code shows it, wrapped in its own read-only preamble and
ExitPlanMode footer, only while the permission mode is `plan`. The append therefore stays
byte-identical across plan/default switches (better prompt caching) and never claims a
fixed mode. For workflow stages the read-only host contract follows the plan body, so it
outranks plan mode's "ask questions" guidance, and it also stays in the append. Instruction
profiles identify these threads as Claude supplement `v12` (shared with the native Task
tools change). Live check, Claude Code 2.1.292, 2026-10-07: a sentinel in
`planModeInstructions` appeared in plan turns only, across default → plan → default → plan
switches made with `setPermissionMode` in one session.

## Transcript retention

F5 defaults Claude's `cleanupPeriodDays` to **3650**. Set the server environment variable
`F5_CLAUDE_CLEANUP_PERIOD_DAYS` to another positive integer; an explicit value in the
instance's isolated `settings.json` wins. Zero, negative and invalid retention values fail
the affected query launch; this is not a server-start validation. Malformed settings JSON
logs a warning and falls back to the validated server default.
Claude's managed-policy precedence remains native. The value is applied at the next
natural session start and is excluded from launch fingerprints, so changing it does
not restart running sessions.

StorageMaintenance and per-profile Claude config directories now retain transcripts
for the intended lifetime of F5 threads. This consumes local disk; monitor profile
storage. Permanent thread deletion will own native transcript cleanup in Release 2;
that hook is not part of Release 0. Already swept transcripts cannot be recovered and
continue using F5's prior-work summary fallback. Full alpha `sessionStore` backups are
not enabled.

## Release 0 runtime verification

The pinned SDK's options and message union are checked by `bun run sdk:audit`; real SDK
query transport probes inspect initialization and spawn arguments without model access.
The bundled SDK uses `spawn(command, args)` with no shell, preserving extra-argument
values as argv. `get_task_output` added in 0.3.292 belongs to the SDK control protocol,
not the SDKMessage stream union.

The [official SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
confirms agent/task/run identity and persistent-approval suppression additions in
0.3.292, interrupted-stream fixes in 0.3.287/0.3.290, and the in-process MCP removal
fix in 0.3.287. Release 0 preserves these identities without adopting later-release UX.
Conversation resets clear persisted rewind boundaries and context estimates. Explicit
`clear` triggers also reset the cost baseline, as documented by SDK 0.3.292; other reset
triggers preserve it. Authenticated live `/clear` observation remains unverified.

## Thinking configuration

Claude provider options accept a typed `thinking` value mirroring the Agent SDK:
`{ "type": "adaptive" }`, `{ "type": "enabled", "budgetTokens": 8000 }` or
`{ "type": "disabled" }`, with an optional `display` of `summarized` or `omitted`.
The deprecated `maxThinkingTokens` is still read and is never rewritten in saved
settings, but F5 no longer sends it to the SDK.

One resolver (`claudeThinkingConfig` in `apps/server/src/provider/claudeProviderOptions.ts`)
serves sessions, one-off prompts and git text generation. Precedence:

1. The composer's per-turn thinking toggle (only on models that offer it). Off sends
   `disabled`. On keeps the shape chosen by a lower layer, but never sends `disabled`.
2. Typed `thinking`.
3. Legacy `maxThinkingTokens`: `0` → `disabled`; a positive value → `adaptive` on
   adaptive models (the budget is ignored, and the session reports
   `thinkingFallback`), otherwise `{ enabled, budgetTokens }`.
4. Native defaults (no `thinking` option).

`thinking` and `alwaysThinkingEnabled` are never sent with conflicting values. An explicit
`adaptive` config for a model F5 knows lacks adaptive thinking is rejected before
launch; unknown models are passed through for the runtime to validate. The effective
mode and its source appear in the session configuration (`thinking`, `thinkingSource`).

Launch identity: settings that use only `maxThinkingTokens` keep their exact
environment key and launch fingerprint, so upgrading restarts nothing. Typed `thinking`
adds an extra fingerprint component and applies at the next session start.

Live finding (Claude Code 2.1.292, Haiku 4.5, 2026-10-07): a mid-session
`applyFlagSettings({ alwaysThinkingEnabled })` did not change thinking in either
direction, with or without a launch `thinking` option. F5 still sends it on model
changes, but in practice a thinking toggle change takes effect at the next session
start. This predates Release 1. The deprecated `setMaxThinkingTokens` control was
removed from F5's runtime interface; it was never called.
